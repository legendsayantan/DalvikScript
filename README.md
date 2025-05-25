# DalvikScript

This is an vscode extension to execute Java code on Android devices without compiling into apps.

## Features

- **Blazing-fast Java execution on Android**  
    Execute Java files or code snippets on a connected Android device, instantly.

- **Execute code with elevated shell access**
    Execute your code with the access and permissions of `shell`.

- **Integrated device detection**  
    Automatically detects connected Android devices and allows to compile for multiple devices at once.

- **Output capture**  
    View standard output from your Java code directly in the VS Code Terminal.

## Extension Settings
This extension contributes the following settings:

* `dalvikscript.androidSdkPath`: Full Path to the Android SDK home directory.
* `dalvikscript.javaHome`: Full path to your JDK home directory, Java 17 or higher.
* `dalvikscript.kotlincPath`: Full path to your kotlin compiler folder, in case you're compiling kotlin files.
* `dalvikscript.dalvikOnly`: Whether to run with the access level of dalvikvm only.

## Instructions

**Write and save a java file, Connect an android device via USB/Wireless Debugging, then Click on the button 'Run on Android' to get started.**

Check the demo folder for general things you can control via DalvikScript, or explore android source to find useful snippets you can invoke using Java Reflection.

In case you cannot see errors or stacktraces on the terminal output, implement `Thread.setDefaultUncaughtExceptionHandler` in your code and redirect the stack trace to stdout. 

Compiling kotlin files may not work properly right now.