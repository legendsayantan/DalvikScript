import * as vscode from 'vscode';
import * as chp from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const exec = util.promisify(chp.execFile);

export function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('dalvikscript');
	const androidSdkPath = config.get<string>('androidSdkPath');
	if (!androidSdkPath) {
		vscode.window.showErrorMessage('Android SDK path is not set. Please check dalvikscript.androidSdkPath.');
		return;
	}
	const adbPath = path.join(androidSdkPath, "platform-tools", "adb.exe");
	checkDevicesPresent(adbPath);
	context.subscriptions.push(
		vscode.commands.registerCommand('dalvikscript.runOnDevice', async () => {

			const chosen = await pickDevices(adbPath);
			if (!chosen || chosen.length === 0) {
				return; // user cancelled
			}
			const files = await pickJavaKotlinFiles();
			if (!files || files.length === 0) {
				vscode.window.showErrorMessage('No Java/Kotlin files selected.');
				return;
			}

			let sdks: Map<string, Array<string>> = new Map();
			for (const device of chosen) {
				const sdk = await getDeviceSdk(adbPath, device);
				sdks.set(sdk, (sdks.get(sdk) || []).concat(device));
			}
			if (sdks.size === 0) {
				vscode.window.showErrorMessage('No devices with valid SDK found.');
				return;
			}
			for (const sdkversion of sdks.keys()) {
				const devices = sdks.get(sdkversion);
				if (!devices || devices.length === 0) {
					continue;
				}
				await downloadAndroidJar(sdkversion, (jarPath) => {
					vscode.window.showInformationMessage(`Compiling files for SDK ${sdkversion}...`);
					compileForDalvik(files, jarPath, androidSdkPath, (success, outputPath) => {
						if (!success) {
							vscode.window.showErrorMessage('Compilation failed.');
							return;
						}
						vscode.window.showInformationMessage(`Compiled successfully to ${outputPath}`);
						//push to ${devices}
						devices.forEach(device => {
							chp.exec(`${adbPath} -s ${device} push "${outputPath}" /data/local/tmp/`, async (err, stdout, stderr) => {
								if (err) {
									vscode.window.showErrorMessage(`Failed to push to device ${device}: ${stderr || err.message}`);
								} else {
									//execution
									let dalvikOnly = config.get<boolean>('dalvikOnly');
									let mainClass = await vscode.window.showInputBox({
										prompt: 'Enter the main class to run (e.g., com.example.Main)',
										value: 'com.example.Main'
									});
									if (!mainClass) {
										vscode.window.showErrorMessage('Main class is required to run the script.');
										return;
									}
									var runCommand = (dalvikOnly)
										? `${adbPath} -s ${device} shell dalvikvm -cp /data/local/tmp/classes.dex ${mainClass}`
										: `${adbPath} -s ${device} shell "app_process -Djava.class.path=/data/local/tmp/classes.dex /system/bin ${mainClass}"`;


									//Run the command on the vscode terminal
									const terminal = vscode.window.activeTerminal || vscode.window.createTerminal({
										name: `Run on ${device}`,
										cwd: (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
											? vscode.workspace.workspaceFolders[0].uri.fsPath
											: os.homedir())
									});
									terminal.show();
									terminal.sendText(runCommand, true);
								}
							});
						});

					});
				});
			}
		})
	);
}

async function checkDevicesPresent(adbPath: string) {
	const devices = await listAdbDevices(adbPath);
	if (devices.length > 0) {
		vscode.window.showInformationMessage('To run this script onto the connected Android devices, use the command "Run on Android".');

	}
}

/**
 * Presents a multi-select QuickPick combining:
 * 1) All open Java/Kotlin editors
 * 2) All .java/.kt files under the current workspace folders
 *
 * Returns an array of URIs the user selected, or undefined if cancelled.
 */
export async function pickJavaKotlinFiles(): Promise<vscode.Uri[] | undefined> {
	const openTabs = vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.filter(tab => {
			// Tab must be a text document and not untitled diff
			return tab.input instanceof vscode.TabInputText;
		});
	const openEditors = Array.from(new Set(
		openTabs
			.map(tab => (tab.input as vscode.TabInputText).uri)
			.filter(uri => ['.java', '.kt'].includes(path.extname(uri.fsPath)))
	));

	const workspaceFiles = await vscode.workspace.findFiles('**/*.{java,kt}', '**/node_modules/**');

	// Merge and de-duplicate URIs
	const allUris = Array.from(new Map(
		[...openEditors, ...workspaceFiles].map(uri => [uri.toString(), uri])
	).values());

	// Build QuickPick items
	const items: vscode.QuickPickItem[] = allUris.map(uri => ({
		label: vscode.workspace.asRelativePath(uri),
		description: uri.fsPath,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select Java/Kotlin files to compile',
	});

	if (!picked || picked.length === 0) {
		return undefined; // user canceled or picked none
	}

	// Map back to URIs
	const selectedUris = picked.map(item => {
		const match = allUris.find(uri => vscode.workspace.asRelativePath(uri) === item.label);
		return match!;
	});

	return selectedUris;
}

/**
 * Compiles selected Java/Kotlin files using the specified android.jar and sdk path.
 * Supports both .java and .kt compilation.
 * @param sourceFiles URIs of source files to compile
 * @param androidJarPath Path to the android.jar for compilation
 * @param sdkPath Path to Android SDK for dx/d8 tools
 * @param callback Called when compilation finishes or fails
 */
export async function compileForDalvik(
	sourceFiles: vscode.Uri[],
	androidJarPath: string,
	sdkPath: string,
	callback: (success: boolean, outputPath?: string) => void
) {
	const outputDir = path.join(vscode.workspace.rootPath || __dirname, '.dalvikrun');
	const classesDir = path.join(outputDir, 'classes');

	fs.rmSync(outputDir, { recursive: true, force: true });
	fs.mkdirSync(classesDir, { recursive: true });

	const config = vscode.workspace.getConfiguration('dalvikscript');
	const javaHome = config.get<string>('javaHome');
	const kotlinPath = config.get<string>('kotlincPath');
	if (!javaHome) {
		vscode.window.showErrorMessage('Java Home is not set. Please check dalvikscript.javaHome.');
		return callback(false);
	}

	const javacPath = path.join(javaHome, 'bin', 'javac');
	const sourcePaths = sourceFiles.map(uri => uri.fsPath);
	const javaFiles = sourcePaths.filter(p => p.endsWith('.java'));
	const kotlinFiles = sourcePaths.filter(p => p.endsWith('.kt'));

	// Helper to proceed to bytecode packaging after compilation
	const packageOutput = () => {
		const outputPath = path.join(outputDir, 'classes.dex');
		// locate d8
		const buildToolsRoot = path.join(sdkPath, 'build-tools');
		const buildVersions = fs.readdirSync(buildToolsRoot).sort().reverse();
		const version = buildVersions.find(v => fs.existsSync(path.join(buildToolsRoot, v, 'd8')) || fs.existsSync(path.join(buildToolsRoot, v, 'd8.bat')));
		if (!version) {
			vscode.window.showErrorMessage('No d8 tool found in build-tools.');
			return callback(false);
		}
		const toolFile = fs.existsSync(path.join(buildToolsRoot, version, 'd8.bat')) ? 'd8.bat' : 'd8';
		const toolPath = path.join(buildToolsRoot, version, toolFile);

		const dexOutDir = path.dirname(outputPath);
		let dexCommand = `"${toolPath}" --output="${dexOutDir}" ${
			fs.readdirSync(classesDir, { recursive: true })
				.filter(f => typeof f === 'string' && f.endsWith('.class'))
				.map(f => '"' + path.join(classesDir, f as string) + '"')
				.join(' ')
		}`;


		chp.exec(dexCommand, {
			env: {
				...process.env,
				JAVA_HOME: javaHome,
				PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH}`
			}
		}, (err, stdout, stderr) => {
			if (err) {
				vscode.window.showErrorMessage(`Dex creation failed: ${stderr || err.message}`);
				return callback(false);
			}
			const generated = path.join(outputDir, 'classes.dex');
			if (generated !== path.join(outputDir, 'classes.dex')) {
				fs.renameSync(generated, path.join(outputDir, 'classes.dex'));
			}
			vscode.window.showInformationMessage(`Dex file created at: ${outputPath}`);
			callback(true, outputPath);
		});
	};

	// 1) Compile Kotlin files first, if any
	if (kotlinFiles.length) {
		if (!kotlinPath) {
			vscode.window.showErrorMessage('Kotlin compiler path is not set. Please check dalvikscript.kotlincPath.');
			return callback(false);
		}
		const stdlibPath = path.join(kotlinPath, 'lib', 'kotlin-stdlib.jar');
		const ktCmd = `${path.join(kotlinPath, 'bin', 'kotlinc')} -include-runtime -classpath "${[androidJarPath, stdlibPath].join(path.delimiter)}" -d "${classesDir}" ${kotlinFiles.map(f => '"' + f + '"').join(' ')}`;
		chp.exec(ktCmd, (err, stdout, stderr) => {
			if (err) {
				vscode.window.showErrorMessage(`Kotlin compilation failed: ${stderr || err.message}`);
				return callback(false);
			}
			// then compile Java
			if (javaFiles.length) {
				const jtCmd = `${javacPath} -classpath "${androidJarPath}" -d "${classesDir}" ${javaFiles.map(f => '"' + f + '"').join(' ')}`;
				chp.exec(jtCmd, (jErr, jOut, jErrOut) => {
					if (jErr) {
						vscode.window.showErrorMessage(`Java compilation failed: ${jErrOut || jErr.message}`);
						return callback(false);
					}
					packageOutput();
				});
			} else {
				packageOutput();
			}
		});
	} else if (javaFiles.length) {
		// only Java
		chp.exec(`${javacPath} -classpath "${androidJarPath}" -d "${classesDir}" ${javaFiles.map(f => '"' + f + '"').join(' ')}`, (err, stdout, stderr) => {
			if (err) {
				vscode.window.showErrorMessage(`Java compilation failed: ${stderr || err.message}`);
				return callback(false);
			}
			packageOutput();
		});
	} else {
		vscode.window.showErrorMessage('No Java or Kotlin files to compile.');
		callback(false);
	}
}



async function listAdbDevices(adbPath: string): Promise<string[]> {
	// adb devices prints lines like "emulator-5554 device"
	const { stdout } = await exec(adbPath, ['devices']);
	return stdout
		.split('\n')
		.filter(line => line.trim().endsWith('device'))
		.map(line => line.split(/\s+/)[0]);
}

async function pickDevices(adbPath: string): Promise<string[] | undefined> {
	const devices = await listAdbDevices(adbPath);
	if (devices.length === 0) {
		vscode.window.showErrorMessage('No devices detected.');
		return;
	}
	return await vscode.window.showQuickPick(devices, {
		canPickMany: true,
		placeHolder: 'Select target device(s)'
	});
}

async function getDeviceSdk(adbPath: string, deviceId: string): Promise<string> {
	const { stdout } = await exec(adbPath, ['-s', deviceId, 'shell', 'getprop', 'ro.build.version.sdk']);
	return stdout.trim();
}

export async function downloadAndroidJar(
	apiLevel: string,
	onDownloaded: (jarPath: string) => void
) {
	const androidSdkPath = vscode.workspace.getConfiguration().get<string>('dalvikscript.androidSdkPath');
	if (!androidSdkPath) {
		vscode.window.showErrorMessage('Android SDK path is not set. Please check dalvikscript.androidSdkPath.');
		return;
	}

	const androidJarPath = path.join(
		androidSdkPath,
		'platforms',
		`android-${apiLevel}`,
		'android.jar'
	);

	// Already cached?
	if (fs.existsSync(androidJarPath)) {
		onDownloaded(androidJarPath);
		return;
	}

	const javaHome = vscode.workspace.getConfiguration().get<string>('dalvikscript.javaHome');
	const sdkManagerPath = path.join(androidSdkPath, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
	vscode.window.showInformationMessage(`Downloading android-${apiLevel} using sdkmanager...`);

	// Run sdkmanager
	chp.exec(
		`"${sdkManagerPath}" "platforms;android-${apiLevel}"`,
		{
			env: {
				...process.env, // inherit current environment
				JAVA_HOME: javaHome,
				SKIP_JDK_VERSION_CHECK: 'true' // override sdkmanager version check
			}
		},
		(err, stdout, stderr) => {
			if (err) {
				vscode.window.showErrorMessage(`Failed to download platform: ${stderr || err.message}`);
				return;
			}

			// Check if the downloaded jar exists
			if (!fs.existsSync(androidJarPath)) {
				vscode.window.showErrorMessage(stderr || stdout);
				vscode.window.showErrorMessage(`platforms/android-${apiLevel}/android.jar not found after download.`);
				return;
			}
			onDownloaded(androidJarPath);
		}
	);
}