import * as vscode from 'vscode';
import * as chp from 'child_process';
import * as util from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFile = util.promisify(chp.execFile);

// Helper constant to identify Windows
const isWin = process.platform === 'win32';

// ── Child-process timeout constants (milliseconds) ────────────────────────────
const TIMEOUT_ADB_FAST   =  10_000;  // adb devices, getprop
const TIMEOUT_ADB_PUSH   =  60_000;  // adb push (file transfer)
const TIMEOUT_COMPILE    = 120_000;  // kotlinc, javac, d8
const TIMEOUT_SDKMANAGER = 600_000;  // sdkmanager platform download

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

/** The three shell families that require distinct escaping and invocation rules. */
type ShellKind = 'bash' | 'powershell' | 'cmd';

/**
 * Identifies the shell family VS Code's integrated terminal is using.
 * 'bash' covers bash, zsh, sh, fish, and any other POSIX-ish shell.
 */
function detectShell(): ShellKind {
	const bin = path.basename(vscode.env.shell ?? '').toLowerCase();
	if (bin === 'powershell.exe' || bin === 'pwsh' || bin === 'pwsh.exe') {
		return 'powershell';
	}
	if (bin === 'cmd.exe') {
		return 'cmd';
	}
	return 'bash';
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
	return detectShell() === 'powershell' ? '& ' : '';
}

/**
 * Escapes mainClass (FQCN + optional arguments) for safe interpolation into a
 * terminal shell command while preserving spaces as argument separators.
 *
 * Two contexts are handled:
 *
 *   'unquoted'  – the value appears as bare tokens at the end of the command
 *                 (dalvikOnly path). Every space-delimited token is
 *                 individually quoted so metacharacters are literal while
 *                 word-splitting still separates class name from args.
 *
 *   'inDQuotes' – the value is embedded inside an existing "…" string that
 *                 the local shell already parses (app_process path). Only
 *                 chars that are special inside double-quotes are escaped;
 *                 spaces remain as-is so the Android shell can still split
 *                 the class name from its arguments.
 */
function escapeMainClass(
	value: string,
	context: 'unquoted' | 'inDQuotes',
	shell: ShellKind
): string {
	if (context === 'unquoted') {
		const tokens = value.trim().split(/\s+/).filter(Boolean);
		switch (shell) {
			case 'powershell':
				// PowerShell double-quotes: backtick-escape internal metacharacters.
				return tokens
					.map(t => `"${t.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')}"`)
					.join(' ');
			case 'cmd':
				// cmd.exe double-quotes: escape % (variable expansion) and " (quote break).
				return tokens
					.map(t => `"${t.replace(/%/g, '%%').replace(/"/g, '""')}"`)
					.join(' ');
			default:
				// bash / zsh / sh: single-quote each token; escape embedded single-quotes.
				return tokens
					.map(t => `'${t.replace(/'/g, "'\\''")}'`)
					.join(' ');
		}
	}

	// context === 'inDQuotes'
	switch (shell) {
		case 'powershell':
			// Inside a PowerShell double-quoted string: backtick-escape metacharacters.
			return value
				.replace(/`/g, '``')
				.replace(/"/g, '`"')
				.replace(/\$/g, '`$');
		case 'cmd':
			// Inside cmd.exe double-quotes: % still expands; " breaks the string.
			return value
				.replace(/%/g, '%%')
				.replace(/"/g, '""');
		default:
			// Inside a bash/zsh double-quoted string: only \, $, `, ", ! are special.
			return value
				.replace(/\\/g, '\\\\')
				.replace(/\$/g, '\\$')
				.replace(/`/g, '\\`')
				.replace(/"/g, '\\"')
				.replace(/!/g, '\\!');
	}
}

let outputChannel: vscode.OutputChannel;

// ── Extension entry point ─────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('DalvikScript');
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(
		vscode.commands.registerCommand('dalvikscript.runOnDevice', async () => {
			// Re-read config on every invocation so settings changes take effect
			// without restarting VS Code (Bug 3: validation moved here from activate).
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

			const chosen = await pickDevices(context, adbPath);
			if (!chosen || chosen.length === 0) {
				return; // user cancelled
			}

			const files = await pickJavaKotlinFiles(context);
			if (!files) {
				return; // cancelled (silent) or empty (error already shown in pickJavaKotlinFiles)
			}

			// Ask for main class once -- before looping over devices.
			// Build a stable, collision-free globalState key by hashing the sorted,
			// NUL-delimited paths with SHA-256.  Raw path concatenation with '+' is
			// ambiguous (a path may contain '+'), order-dependent, and unbounded in
			// length.  Sorting makes the key identical regardless of pick order;
			// NUL as separator is unambiguous because it cannot appear in a path.
			const filesKey = crypto
				.createHash('sha256')
				.update(files.map(f => f.fsPath).sort().join('\0'))
				.digest('hex');
			const dalvikOnly  = config.get<boolean>('dalvikOnly');
			const mainClass   = await vscode.window.showInputBox({
				prompt:      'Enter the main class to run (optionally followed by arguments)',
				placeHolder: 'com.example.Main arg1 arg2',
				value:       context.globalState.get(`dalvikscript.mainClassForFiles.${filesKey}`, ''),
			});
			if (!mainClass) {
				vscode.window.showErrorMessage('Main class is required to run the script.');
				return;
			}
			await context.globalState.update(`dalvikscript.mainClassForFiles.${filesKey}`, mainClass);

			// Detect the active shell once, then build every runCommand from it.
			const shell     = detectShell();
			const prefix    = shell === 'powershell' ? '& ' : '';
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
						await execFile(adbPath, ['-s', device, 'push', outputPath, '/data/local/tmp/'], { timeout: TIMEOUT_ADB_PUSH });
					} catch (e: any) {
						vscode.window.showErrorMessage(`Failed to push to ${device}: ${e.message}`);
						continue;
					}

					// Escape the device serial and mainClass for the active shell.
					// Device serials (e.g. emulator-5554, 192.168.1.1:5555) are
					// normally safe, but escaping them closes the same injection
					// class as mainClass and costs nothing.
					const safeDevice = escapeMainClass(device, 'unquoted', shell);
					const runCommand = dalvikOnly
						? `${adbInvoke} -s ${safeDevice} shell dalvikvm -cp /data/local/tmp/classes.dex` +
						  ` ${escapeMainClass(mainClass, 'unquoted', shell)}`
						: `${adbInvoke} -s ${safeDevice} shell "app_process` +
						  ` -Djava.class.path=/data/local/tmp/classes.dex` +
						  `:/system/framework/services.jar` +
						  `:/apex/com.android.services/javalib/services.jar` +
						  `:/apex/com.android.runtime/javalib/core-oj.jar` +
						  `:/system/framework/framework2.jar` +
						  `:/system/framework/services-core.jar` +
						  ` /system/bin ${escapeMainClass(mainClass, 'inDQuotes', shell)}"`;

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

	// Best-effort startup check: if the SDK is already configured, notify the
	// user about any connected devices.  This never blocks command registration.
	{
		const cfg     = vscode.workspace.getConfiguration('dalvikscript');
		const sdkPath = cfg.get<string>('androidSdkPath');
		if (sdkPath && fs.existsSync(sdkPath)) {
			const adb = path.join(sdkPath, 'platform-tools', adbBinary());
			if (fs.existsSync(adb)) { checkDevicesPresent(adb); }
		}
	}
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
	const { stdout } = await execFile(adbPath, ['devices'], { timeout: TIMEOUT_ADB_FAST, encoding: 'utf8' as const });
	return stdout
		.split('\n')
		.filter(line => line.trim().endsWith('device'))
		.map(line => line.split(/\s+/)[0]);
}

async function pickDevices(
	context: vscode.ExtensionContext,
	adbPath: string
): Promise<string[] | undefined> {
	let devices: string[];
	try {
		devices = await listAdbDevices(adbPath);
	} catch (e: any) {
		vscode.window.showErrorMessage(
			`Failed to query ADB devices: ${e.message ?? String(e)}`
		);
		return undefined;
	}
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
	// Only persist the selection when the user explicitly confirms (targets is
	// defined).  If they press Escape, showQuickPick returns undefined and we
	// leave the previously saved devices untouched (Bug 4 fix).
	if (targets !== undefined) {
		await context.globalState.update(
			'dalvikscript.savedDevices',
			targets.map(item => item.label)
		);
	}
	return targets?.map(item => item.label);
}

async function getDeviceSdk(adbPath: string, deviceId: string): Promise<string> {
	const { stdout } = await execFile(adbPath, ['-s', deviceId, 'shell', 'getprop', 'ro.build.version.sdk'], { timeout: TIMEOUT_ADB_FAST, encoding: 'utf8' as const });
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

	if (picked === undefined) {
		// User pressed Escape — treat as a deliberate abort, not an error.
		return undefined;
	}
	if (picked.length === 0) {
		vscode.window.showErrorMessage('No Java/Kotlin files selected.');
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
	// Hoisted so the d8 step below can decide whether to add kotlin-stdlib.jar.
	const includeRuntime = config.get<boolean>('kotlinIncludeRuntime', false);

	if (kotlinFiles.length) {
		if (!kotlinPath || !fs.existsSync(kotlinPath)) {
			throw new Error('Kotlin compiler path is missing or invalid. Please check dalvikscript.kotlincPath.');
		}
		const kotlincPath = path.join(kotlinPath, 'bin', kotlincBinary());
		if (!fs.existsSync(kotlincPath)) {
			throw new Error(`Kotlin compiler not found at "${kotlincPath}". Please verify dalvikscript.kotlincPath.`);
		}

		const ktArgs = [
			// -include-runtime embeds the entire Kotlin stdlib (~1.6 MB) into the
			// jar before it is DEX'd.  Omit it when the runtime is already present
			// on the device (the common case for rooted / shell-accessible devices).
			...(includeRuntime ? ['-include-runtime'] : []),
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
				cwd: isWin ? path.dirname(kotlincPath) : undefined,
				timeout: TIMEOUT_COMPILE,
				encoding: 'utf8' as const,
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
			const { stdout, stderr } = await execFile(javacPath, jtArgs, { env: javaEnv, timeout: TIMEOUT_COMPILE, encoding: 'utf8' as const });
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
		// Sort descending by numeric version components so 33.0.10 > 33.0.2.
		// A plain .sort() is lexicographic: '33.0.2' > '33.0.10' because '2' > '1'.
		buildVersions = fs.readdirSync(buildToolsRoot).sort((a, b) => {
			const pa = a.split('.').map(Number);
			const pb = b.split('.').map(Number);
			for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
				const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
				if (diff !== 0) { return diff; }
			}
			return 0;
		});
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

		// When -include-runtime is NOT used, kotlinc produces a jar that contains
		// only the user's classes.  Kotlin lambda types (Function0, Function1, ...),
		// collections helpers, and every other stdlib symbol are absent from the
		// dex unless we feed the stdlib jars to d8 explicitly.
		//
		// Modern kotlinc (>= 1.8) ships a single merged kotlin-stdlib.jar.
		// Older installations split the JDK extensions into separate jars;
		// we add all three if they exist so the build works regardless of version.
		if (!includeRuntime && kotlinPath) {
			const stdlibCandidates = [
				'kotlin-stdlib.jar',
				'kotlin-stdlib-jdk7.jar',   // merged into stdlib in 1.8; harmless if absent
				'kotlin-stdlib-jdk8.jar',   // merged into stdlib in 1.8; harmless if absent
			];
			let foundAny = false;
			for (const jar of stdlibCandidates) {
				const jarPath = path.join(kotlinPath, 'lib', jar);
				if (fs.existsSync(jarPath)) {
					classFiles.push(jarPath);
					outputChannel.appendLine(`[d8] including ${jar}: ${q(jarPath)}`);
					foundAny = true;
				}
			}
			if (!foundAny) {
				outputChannel.appendLine(
					`[d8] warning: kotlin-stdlib.jar not found under "${path.join(kotlinPath, 'lib')}". ` +
					`Lambda types will be missing at runtime. ` +
					`Either enable dalvikscript.kotlinIncludeRuntime or verify dalvikscript.kotlincPath.`
				);
			}
		}
	}

	if (classFiles.length === 0) {
		throw new Error('Compiler produced no .class files. Check the DalvikScript output channel.');
	}

	const outputPath = path.join(outputDir, 'classes.dex');
	const dexArgs    = [
		'--lib', wrap(androidJarPath),
		'--output', wrap(outputDir),
		...classFiles.map(wrap)
	];

	outputChannel.appendLine(`[d8] ${q(toolPath)} ${dexArgs.map(q).join(' ')}`);
	try {
		const d8Exe = isWin ? path.basename(toolPath) : toolPath;
		const { stdout, stderr } = await execFile(d8Exe, dexArgs, { 
			env: javaEnv, 
			shell: isWin,
			cwd: isWin ? path.dirname(toolPath) : undefined,
			timeout: TIMEOUT_COMPILE,
			encoding: 'utf8' as const,
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
		// sdkmanager prompts "Accept? (y/N)" for each SDK license before downloading.
		// Without stdin input the process blocks indefinitely. Piping repeated 'y\n'
		// answers every prompt automatically, mirroring `yes | sdkmanager ...`.
		//
		// JAVA_HOME alone is not sufficient: sdkmanager's own launch script
		// resolves the java binary through PATH, not JAVA_HOME. Prepend
		// JAVA_HOME/bin so that the correct JDK is found even when java is not
		// on the system PATH at all.
		const sysPath  = process.env.PATH ?? process.env.Path ?? '';
		const sdkEnv: NodeJS.ProcessEnv = {
			...process.env,
			JAVA_HOME: javaHome,
			PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${sysPath}`,
			SKIP_JDK_VERSION_CHECK: 'true',
		};
		// Windows cmd.exe may consult 'Path' instead of (or in addition to) 'PATH'.
		if (isWin && 'Path' in process.env) {
			sdkEnv.Path = sdkEnv.PATH;
		}
		// 'input' is processed by Node's execFile at runtime (it writes to stdin and
		// calls .end()) but is absent from @types/node's ExecFileOptions.  Cast the
		// function itself so we can pass it without breaking overload resolution,
		// then restore the return type explicitly.
		type ExecFileWithInput = (
			file: string, args: readonly string[],
			opts: chp.ExecFileOptionsWithStringEncoding & { input?: string }
		) => Promise<{ stdout: string; stderr: string }>;
		const { stdout, stderr } = await (execFile as unknown as ExecFileWithInput)(sdkExe, args, {
			env: sdkEnv,
			shell: isWin,
			cwd: isWin ? path.dirname(sdkManagerPath) : undefined,
			input: 'y\n'.repeat(20),
			timeout: TIMEOUT_SDKMANAGER,
			encoding: 'utf8',
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