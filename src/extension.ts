import * as vscode from 'vscode';
import * as chp from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFile = util.promisify(chp.execFile);

// Helper constant to identify Windows
const isWin = process.platform === 'win32';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wraps a filesystem path in double-quotes for safe shell logging. */
function q(p: string): string {
	return (p.includes(' ') && !(p.startsWith('"') && p.endsWith('"'))) ? `"${p}"` : p;
}

/** Quotes arguments for Windows cmd.exe since execFile with shell:true joins by space. */
function wrap(p: string): string {
	return isWin && p.includes(' ') ? `"${p}"` : p;
}

/** Formats child_process error output to extract stdout/stderr safely. */
function formatExecError(e: any): string {
	const out = e.stdout?.toString().trim();
	const err = e.stderr?.toString().trim();
	return [out, err].filter(Boolean).join('\n') || e.message || String(e);
}

/** Shows an error message with a button to open VS Code settings. */
function showErrorWithSettings(message: string, settingId: string = 'dalvikscript') {
	vscode.window.showErrorMessage(message, 'Open Settings').then(selection => {
		if (selection === 'Open Settings') {
			vscode.commands.executeCommand('workbench.action.openSettings', settingId);
		}
	});
}

/** Returns the correct adb binary name for the running platform. */
function adbBinary(): string {
	return isWin ? 'adb.exe' : 'adb';
}

/** Returns the correct sdkmanager script name for the running platform. */
function sdkManagerBinary(): string {
	return isWin ? 'sdkmanager.bat' : 'sdkmanager';
}

/** Returns the correct kotlinc script name for the running platform. */
function kotlincBinary(): string {
	return isWin ? 'kotlinc.bat' : 'kotlinc';
}

/** Returns the correct javac binary name for the running platform. */
function javacBinary(): string {
	return isWin ? 'javac.exe' : 'javac';
}

/**
 * Returns the prefix required to invoke a double-quoted executable path in
 * whichever shell VS Code's integrated terminal is configured to use.
 *
 * PowerShell (powershell.exe and pwsh / pwsh.exe) treats a line that starts
 * with a double-quoted string as a *string expression*, not a command. Its
 * call operator `& ` must be prepended to make it an invocation.
 *
 * cmd.exe, bash, zsh, sh, and fish execute a leading quoted path directly, so
 * no prefix is needed for those.
 *
 * vscode.env.shell reflects the user's active terminal profile and is the most
 * accurate signal, because it is exactly what createTerminal will open.
 */
function shellCallPrefix(): string {
	const shell = vscode.env.shell ?? '';
	const bin   = path.basename(shell).toLowerCase();
	const isPowerShell = bin === 'powershell.exe' || bin === 'pwsh' || bin === 'pwsh.exe';
	return isPowerShell ? '& ' : '';
}

let outputChannel: vscode.OutputChannel;

// ── Extension entry point ─────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('DalvikScript');
	context.subscriptions.push(outputChannel);

	const config         = vscode.workspace.getConfiguration('dalvikscript');
	const androidSdkPath = config.get<string>('androidSdkPath');
	
	if (!androidSdkPath || !fs.existsSync(androidSdkPath)) {
		showErrorWithSettings(
			'Android SDK path is missing or invalid. Please configure dalvikscript.androidSdkPath.', 
			'dalvikscript.androidSdkPath'
		);
		return;
	}

	const adbPath = path.join(androidSdkPath, 'platform-tools', adbBinary());
	if (!fs.existsSync(adbPath)) {
		showErrorWithSettings(
			`adb not found at "${adbPath}". Please verify dalvikscript.androidSdkPath.`,
			'dalvikscript.androidSdkPath'
		);
		return;
	}

	checkDevicesPresent(adbPath);

	context.subscriptions.push(
		vscode.commands.registerCommand('dalvikscript.runOnDevice', async () => {
			const chosen = await pickDevices(context, adbPath);
			if (!chosen || chosen.length === 0) {
				return; // user cancelled
			}

			const files = await pickJavaKotlinFiles(context);
			if (!files || files.length === 0) {
				vscode.window.showErrorMessage('No Java/Kotlin files selected.');
				return;
			}

			// Ask for main class once -- before looping over devices.
			const filesString = files.map(f => f.fsPath).join('+');
			const dalvikOnly  = config.get<boolean>('dalvikOnly');
			const mainClass   = await vscode.window.showInputBox({
				prompt:      'Enter the main class to run (optionally followed by arguments)',
				placeHolder: 'com.example.Main arg1 arg2',
				value:       context.globalState.get(`dalvikscript.mainClassForFiles.${filesString}`, ''),
			});
			if (!mainClass) {
				vscode.window.showErrorMessage('Main class is required to run the script.');
				return;
			}
			await context.globalState.update(`dalvikscript.mainClassForFiles.${filesString}`, mainClass);

			// Detect the active shell once, then build every runCommand from it.
			const prefix    = shellCallPrefix();
			const adbInvoke = prefix ? `${prefix}${q(adbPath)}` : q(adbPath);
			outputChannel.appendLine(
				`[shell] ${vscode.env.shell ?? '(unknown)'}  prefix=${JSON.stringify(prefix)}`
			);

			// Group devices by SDK version so we only compile once per SDK.
			const sdks = new Map<string, string[]>();
			for (const device of chosen) {
				try {
					const sdk = await getDeviceSdk(adbPath, device);
					sdks.set(sdk, (sdks.get(sdk) ?? []).concat(device));
				} catch (e: any) {
					vscode.window.showErrorMessage(`Could not query SDK for device ${device}: ${e.message}`);
				}
			}
			if (sdks.size === 0) {
				vscode.window.showErrorMessage('No devices with a valid SDK version found.');
				return;
			}

			for (const [sdkVersion, devices] of sdks) {
				// 1) Ensure android.jar is available.
				let jarPath: string;
				try {
					jarPath = await downloadAndroidJar(sdkVersion);
				} catch (e: any) {
					const msg = e.message;
					if (msg.includes('dalvikscript.')) {
						showErrorWithSettings(`Failed to obtain android.jar: ${msg}`);
					} else {
						vscode.window.showErrorMessage(`Failed to obtain android.jar for SDK ${sdkVersion}: ${msg}`);
					}
					continue;
				}

				// 2) Compile.
				vscode.window.showInformationMessage(`Compiling for SDK ${sdkVersion}...`);
				let outputPath: string;
				try {
					outputPath = await compileForDalvik(files, sdkVersion, jarPath, androidSdkPath);
				} catch (e: any) {
					outputChannel.show(true);
					const msg = e.message;
					if (msg.includes('dalvikscript.')) {
						showErrorWithSettings(`Compilation failed: ${msg}`);
					} else {
						vscode.window.showErrorMessage(`Compilation failed: ${msg}`);
					}
					continue;
				}
				vscode.window.showInformationMessage(`Compiled -> ${outputPath}`);

				// 3) Push and run on each device.
				for (const device of devices) {
					try {
						// execFile uses an argument array so the OS handles quoting natively.
						await execFile(adbPath, ['-s', device, 'push', outputPath, '/data/local/tmp/']);
					} catch (e: any) {
						vscode.window.showErrorMessage(`Failed to push to ${device}: ${e.message}`);
						continue;
					}

					// adbInvoke integrates smoothly with Bash/ZSH (Linux/Mac) and PowerShell/CMD (Windows).
					const runCommand = dalvikOnly
						? `${adbInvoke} -s ${device} shell dalvikvm -cp /data/local/tmp/classes.dex ${mainClass}`
						: `${adbInvoke} -s ${device} shell "app_process` +
						  ` -Djava.class.path=/data/local/tmp/classes.dex` +
						  `:/system/framework/services.jar` +
						  `:/apex/com.android.services/javalib/services.jar` +
						  `:/apex/com.android.runtime/javalib/core-oj.jar` +
						  `:/system/framework/framework2.jar` +
						  `:/system/framework/services-core.jar` +
						  ` /system/bin ${mainClass}"`;

					outputChannel.appendLine(`[run] ${runCommand}`);
					const terminal = vscode.window.createTerminal({
						name: `DalvikScript - ${device}`,
						cwd:  vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
					});
					terminal.show();
					terminal.sendText(runCommand, true);
				}
			}
		})
	);
}

// ── Device helpers ────────────────────────────────────────────────────────────

async function checkDevicesPresent(adbPath: string) {
	try {
		const devices = await listAdbDevices(adbPath);
		if (devices.length > 0) {
			vscode.window.showInformationMessage(
				'Android device(s) detected. Use "Run on Android" to deploy a script.'
			);
		}
	} catch {
		// adb may not be ready yet -- silently ignore.
	}
}

async function listAdbDevices(adbPath: string): Promise<string[]> {
	const { stdout } = await execFile(adbPath, ['devices']);
	return stdout
		.split('\n')
		.filter(line => line.trim().endsWith('device'))
		.map(line => line.split(/\s+/)[0]);
}

async function pickDevices(
	context: vscode.ExtensionContext,
	adbPath: string
): Promise<string[] | undefined> {
	const devices = await listAdbDevices(adbPath);
	if (devices.length === 0) {
		vscode.window.showErrorMessage('No ADB devices detected. Make sure USB debugging is enabled.');
		return;
	}
	const savedDevices = context.globalState.get<string[]>('dalvikscript.savedDevices', []);
	const items: vscode.QuickPickItem[] = devices.map(device => ({
		label:  device,
		picked: savedDevices.includes(device),
	}));
	const targets = await vscode.window.showQuickPick(items, {
		canPickMany:  true,
		placeHolder: 'Select target device(s)',
	});
	await context.globalState.update(
		'dalvikscript.savedDevices',
		targets?.map(item => item.label) ?? []
	);
	return targets?.map(item => item.label) ?? [];
}

async function getDeviceSdk(adbPath: string, deviceId: string): Promise<string> {
	const { stdout } = await execFile(adbPath, ['-s', deviceId, 'shell', 'getprop', 'ro.build.version.sdk']);
	const sdk = stdout.trim();
	if (!sdk) {
		throw new Error(`Empty SDK version returned for device ${deviceId}.`);
	}
	return sdk;
}

// ── File picker ───────────────────────────────────────────────────────────────

export async function pickJavaKotlinFiles(
	context: vscode.ExtensionContext
): Promise<vscode.Uri[] | undefined> {
	const openEditors = Array.from(
		new Map(
			vscode.window.tabGroups.all
				.flatMap(group => group.tabs)
				.filter(tab => tab.input instanceof vscode.TabInputText)
				.map(tab => (tab.input as vscode.TabInputText).uri)
				.filter(uri => ['.java', '.kt'].includes(path.extname(uri.fsPath)))
				.map(uri => [uri.toString(), uri] as const)
		).values()
	);

	const workspaceFiles = await vscode.workspace.findFiles(
		'**/*.{java,kt}',
		'**/node_modules/**'
	);

	const allUris = Array.from(
		new Map(
			[...openEditors, ...workspaceFiles].map(uri => [uri.toString(), uri])
		).values()
	);

	const savedPicks = context.globalState.get<string[]>('dalvikscript.savedPicks', []);

	const items: vscode.QuickPickItem[] = allUris.map(uri => ({
		label:       vscode.workspace.asRelativePath(uri),
		description: uri.fsPath,
		picked:      savedPicks.includes(uri.fsPath),
	}));

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany:  true,
		placeHolder: 'Select Java/Kotlin files to compile',
	});

	if (!picked || picked.length === 0) {
		return undefined;
	}

	await context.globalState.update(
		'dalvikscript.savedPicks',
		picked.map(item => item.description)
	);

	return picked.map(item => allUris.find(uri => uri.fsPath === item.description)!);
}

// ── Compilation ───────────────────────────────────────────────────────────────

export async function compileForDalvik(
	sourceFiles:     vscode.Uri[],
	sdkVersion:      string,
	androidJarPath:  string,
	sdkPath:         string
): Promise<string> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? __dirname;
	const outputDir     = path.join(workspaceRoot, '.dalvikrun', `dex-${sdkVersion}`);
	const classesDir    = path.join(workspaceRoot, '.dalvikrun', 'classes');
	const ktJarPath     = path.join(outputDir, 'kotlin-classes.jar');

	fs.rmSync(outputDir,  { recursive: true, force: true });
	fs.rmSync(classesDir, { recursive: true, force: true });
	fs.mkdirSync(outputDir,  { recursive: true });
	fs.mkdirSync(classesDir, { recursive: true });

	const config     = vscode.workspace.getConfiguration('dalvikscript');
	const javaHome   = config.get<string>('javaHome');
	const kotlinPath = config.get<string>('kotlincPath');

	if (!javaHome || !fs.existsSync(javaHome)) {
		throw new Error('Java Home is missing or invalid. Please check dalvikscript.javaHome.');
	}

	const javaBinPath = path.join(javaHome, 'bin', isWin ? 'java.exe' : 'java');
	if (!fs.existsSync(javaBinPath)) {
		throw new Error(`Java runtime not found at "${javaBinPath}". Please verify dalvikscript.javaHome.`);
	}

	const sysPath = process.env.PATH ?? process.env.Path ?? '';
	const javaEnv: any = {
		...process.env,
		JAVA_HOME: javaHome,
		PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${sysPath}`,
	};
	// Windows systems can sometimes strictly require 'Path' over 'PATH'
	if ('Path' in javaEnv) {
		javaEnv.Path = javaEnv.PATH;
	}
	
	const sourcePaths = sourceFiles.map(uri => uri.fsPath);
	const javaFiles   = sourcePaths.filter(p => p.endsWith('.java'));
	const kotlinFiles = sourcePaths.filter(p => p.endsWith('.kt'));

	if (kotlinFiles.length === 0 && javaFiles.length === 0) {
		throw new Error('No Java or Kotlin files to compile.');
	}

	// ── 1) Kotlin compilation ─────────────────────────────────────────────────
	if (kotlinFiles.length) {
		if (!kotlinPath || !fs.existsSync(kotlinPath)) {
			throw new Error('Kotlin compiler path is missing or invalid. Please check dalvikscript.kotlincPath.');
		}
		const kotlincPath = path.join(kotlinPath, 'bin', kotlincBinary());
		if (!fs.existsSync(kotlincPath)) {
			throw new Error(`Kotlin compiler not found at "${kotlincPath}". Please verify dalvikscript.kotlincPath.`);
		}
		
		const ktArgs = [
			'-include-runtime',
			'-classpath', wrap(androidJarPath),
			'-d', wrap(ktJarPath),
			...kotlinFiles.map(wrap)
		];

		// For log readability we quote paths visually
		outputChannel.appendLine(`[kotlinc] ${q(kotlincPath)} ${ktArgs.map(q).join(' ')}`);
		try {
			// shell: isWin ensures Windows .bat files are runnable, while Mac/Linux natively execute
			// By setting cwd and executing the basename, we prevent Windows cmd.exe from stripping quotes on paths with spaces
			const ktExe = isWin ? path.basename(kotlincPath) : kotlincPath;
			const { stdout, stderr } = await execFile(ktExe, ktArgs, { 
				env: javaEnv, 
				shell: isWin,
				cwd: isWin ? path.dirname(kotlincPath) : undefined 
			});
			if (stdout?.trim()) { outputChannel.appendLine(`[kotlinc output]\n${stdout.trim()}`); }
			if (stderr?.trim()) { outputChannel.appendLine(`[kotlinc stderr]\n${stderr.trim()}`); }
		} catch (e: any) {
			outputChannel.appendLine(`[kotlinc error]\n${formatExecError(e)}`);
			throw new Error('Kotlin compilation failed -- see DalvikScript output for details.');
		}
	}

	// ── 2) Java compilation ───────────────────────────────────────────────────
	if (javaFiles.length) {
		const javacPath = path.join(javaHome, 'bin', javacBinary());
		if (!fs.existsSync(javacPath)) {
			throw new Error(`Java compiler not found at "${javacPath}". Please ensure dalvikscript.javaHome points to a JDK, not just a JRE.`);
		}

		const cp = kotlinFiles.length ? `${androidJarPath}${path.delimiter}${ktJarPath}` : androidJarPath;
		
		const jtArgs = [
			'-classpath', cp,
			'-d', classesDir,
			...javaFiles
		];

		outputChannel.appendLine(`[javac] ${q(javacPath)} ${jtArgs.map(q).join(' ')}`);
		try {
			// javac is a native executable (.exe), it doesn't need to be run through cmd.exe. 
			// Calling it directly prevents cmd.exe from improperly stripping quotes around spaces.
			const { stdout, stderr } = await execFile(javacPath, jtArgs, { env: javaEnv });
			if (stdout?.trim()) { outputChannel.appendLine(`[javac output]\n${stdout.trim()}`); }
			if (stderr?.trim()) { outputChannel.appendLine(`[javac stderr]\n${stderr.trim()}`); }
		} catch (e: any) {
			outputChannel.appendLine(`[javac error]\n${formatExecError(e)}`);
			throw new Error('Java compilation failed -- see DalvikScript output for details.');
		}
	}

	// ── 3) DEX packaging via d8 ───────────────────────────────────────────────
	const buildToolsRoot = path.join(sdkPath, 'build-tools');
	let buildVersions: string[];
	try {
		buildVersions = fs.readdirSync(buildToolsRoot).sort().reverse();
	} catch {
		throw new Error(`build-tools directory not found under "${buildToolsRoot}".`);
	}

	const d8Bin   = isWin ? 'd8.bat' : 'd8';
	const version = buildVersions.find(v => fs.existsSync(path.join(buildToolsRoot, v, d8Bin)));
	if (!version) {
		throw new Error('No d8 tool found in build-tools. Install a build-tools package via sdkmanager.');
	}
	const toolPath = path.join(buildToolsRoot, version, d8Bin);

	const classFiles: string[] = [];
	if (fs.existsSync(classesDir)) {
		const jClasses = (fs.readdirSync(classesDir, { recursive: true }) as string[])
			.filter(f => f.endsWith('.class'))
			.map(f => path.join(classesDir, f)); // execFile correctly escapes spaces natively
		classFiles.push(...jClasses);
	}

	if (kotlinFiles.length && fs.existsSync(ktJarPath)) {
		classFiles.push(ktJarPath);
	}

	if (classFiles.length === 0) {
		throw new Error('Compiler produced no .class files. Check the DalvikScript output channel.');
	}

	const outputPath = path.join(outputDir, 'classes.dex');
	const dexArgs    = [
		'--output', wrap(outputDir),
		...classFiles.map(wrap)
	];

	outputChannel.appendLine(`[d8] ${q(toolPath)} ${dexArgs.map(q).join(' ')}`);
	try {
		const d8Exe = isWin ? path.basename(toolPath) : toolPath;
		const { stdout, stderr } = await execFile(d8Exe, dexArgs, { 
			env: javaEnv, 
			shell: isWin,
			cwd: isWin ? path.dirname(toolPath) : undefined 
		});
		if (stdout?.trim()) { outputChannel.appendLine(`[d8 output]\n${stdout.trim()}`); }
		if (stderr?.trim()) { outputChannel.appendLine(`[d8 stderr]\n${stderr.trim()}`); }
	} catch (e: any) {
		outputChannel.appendLine(`[d8 error]\n${formatExecError(e)}`);
		throw new Error('DEX creation failed -- see DalvikScript output for details.');
	}

	if (!fs.existsSync(outputPath)) {
		throw new Error('classes.dex was not produced. Check the DalvikScript output channel.');
	}
	return outputPath;
}

// ── Android SDK management ────────────────────────────────────────────────────

export async function downloadAndroidJar(apiLevel: string): Promise<string> {
	const config = vscode.workspace.getConfiguration('dalvikscript');
	const androidSdkPath = config.get<string>('androidSdkPath');
	
	if (!androidSdkPath || !fs.existsSync(androidSdkPath)) {
		throw new Error('Android SDK path is missing or invalid. Please check dalvikscript.androidSdkPath.');
	}

	const androidJarPath = path.join(
		androidSdkPath, 'platforms', `android-${apiLevel}`, 'android.jar'
	);

	if (fs.existsSync(androidJarPath)) {
		return androidJarPath; // already cached
	}

	const javaHome = config.get<string>('javaHome');
	if (!javaHome || !fs.existsSync(javaHome)) {
		throw new Error('Java Home is invalid. sdkmanager requires a valid dalvikscript.javaHome.');
	}

	const sdkManagerPath = path.join(
		androidSdkPath, 'cmdline-tools', 'latest', 'bin', sdkManagerBinary()
	);
	if (!fs.existsSync(sdkManagerPath)) {
		throw new Error(
			`sdkmanager not found at "${sdkManagerPath}". Install cmdline-tools via Android Studio or check dalvikscript.androidSdkPath.`
		);
	}

	vscode.window.showInformationMessage(
		`Downloading android-${apiLevel} platform via sdkmanager...`
	);
	
	const args = [`platforms;android-${apiLevel}`];
	outputChannel.appendLine(`[sdkmanager] ${q(sdkManagerPath)} ${args.map(q).join(' ')}`);

	try {
		const sdkExe = isWin ? path.basename(sdkManagerPath) : sdkManagerPath;
		const { stdout, stderr } = await execFile(sdkExe, args, {
			env: {
				...process.env,
				JAVA_HOME: javaHome,
				SKIP_JDK_VERSION_CHECK: 'true',
			},
			shell: isWin,
			cwd: isWin ? path.dirname(sdkManagerPath) : undefined
		});
		if (stdout?.trim()) { outputChannel.appendLine(`[sdkmanager output]\n${stdout.trim()}`); }
		if (stderr?.trim()) { outputChannel.appendLine(`[sdkmanager stderr]\n${stderr.trim()}`); }
	} catch (e: any) {
		outputChannel.appendLine(`[sdkmanager error]\n${formatExecError(e)}`);
		throw new Error('sdkmanager failed -- see DalvikScript output for details.');
	}

	if (!fs.existsSync(androidJarPath)) {
		throw new Error(
			`platforms/android-${apiLevel}/android.jar not found after download.`
		);
	}
	return androidJarPath;
}