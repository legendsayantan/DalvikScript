import android.annotation.SuppressLint
import dalvik.system.DexFile
import java.lang.reflect.Modifier
/**
 * Deep Reflection Scanner for Android
 * Compile and run via DalvikScript to dump complete class hierarchies, as they exist on your system.
 */
object ClassScanner {

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.isEmpty()) {
            println("[-] Error: No target class specified.")
            println("Usage: app_process ... ClassScanner <fully.qualified.ClassName>")
            return
        }

        val targetClassName = args[0]
        
        // 1. Bypass Hidden API Restrictions First
        bypassHiddenApi()

        // 2. Load the target class and analyze
        try {
            val targetClass = Class.forName(targetClassName)
            analyzeClass(targetClass)
        } catch (e: ClassNotFoundException) {
            println("[-] Error: Class '$targetClassName' not found.")
        } catch (e: Exception) {
            println("[-] Error analyzing class:")
            e.printStackTrace()
        }
    }

    @SuppressLint("DiscouragedPrivateApi")
    private fun bypassHiddenApi() {
        try {
            // Use arrayOf<Class<*>>()::class.java to satisfy Kotlin's type constraints
            val getDeclaredMethod = Class::class.java.getDeclaredMethod(
                "getDeclaredMethod",
                String::class.java,
                arrayOf<Class<*>>()::class.java
            )
            
            val vmRuntimeClass = Class.forName("dalvik.system.VMRuntime")
            
            val getRuntimeMethod = getDeclaredMethod.invoke(
                vmRuntimeClass,
                "getRuntime",
                arrayOf<Class<*>>()
            ) as java.lang.reflect.Method
            
            val vmRuntime = getRuntimeMethod.invoke(null)
            
            val setHiddenApiExemptionsMethod = getDeclaredMethod.invoke(
                vmRuntimeClass,
                "setHiddenApiExemptions",
                arrayOf<Class<*>>(Array<String>::class.java)
            ) as java.lang.reflect.Method
            
            // Just pass the String array directly. Kotlin automatically wraps it 
            // into the correct vararg position for Method.invoke()
            setHiddenApiExemptionsMethod.invoke(
                vmRuntime,
                arrayOf("L")
            )
            println("[+] Hidden API restrictions bypassed successfully.")
        } catch (e: Exception) {
            println("[-] Fatal error bypassing Hidden API:")
            e.printStackTrace()
        }
    }

    private fun analyzeClass(clazz: Class<*>) {
        println("\n==================================================")
        println(" CLASS HIERARCHY & SIGNATURES: ${clazz.simpleName}")
        println("==================================================")

        printHierarchy(clazz)
        printSubclasses(clazz)
        printFields(clazz)
        printConstructors(clazz)
        printMethods(clazz)
    }

    private fun printHierarchy(clazz: Class<*>) {
        println("\n[+] SUPERCLASSES & INTERFACES")
        
        var current: Class<*>? = clazz
        var indent = ""
        while (current != null) {
            val modifiers = Modifier.toString(current.modifiers)
            println("$indent├── $modifiers ${current.name}")
            
            val interfaces = current.interfaces
            if (interfaces.isNotEmpty()) {
                val ifaceIndent = "$indent│   ├── [Implements] "
                interfaces.forEach { iface ->
                    println("$ifaceIndent${iface.name}")
                }
            }
            
            current = current.superclass
            indent += "    "
        }
    }

    private fun printSubclasses(targetClass: Class<*>) {
        println("\n[+] SCANNING FOR SUBCLASSES (Via Global Dex Paths)...")
        if (Modifier.isFinal(targetClass.modifiers)) {
            println("    └── Class is final. Cannot have subclasses.")
            return
        }

        // Collect all available DEX paths in the current execution environment
        val pathsToScan = LinkedHashSet<String>()

        // 1. App Process CLASSPATH (Our jar + injected framework jars like services.jar)
        System.getProperty("java.class.path")?.split(":")?.forEach { if (it.isNotBlank()) pathsToScan.add(it) }

        // 2. Android Boot Classpath (Core framework like core-oj.jar, framework.jar)
        System.getenv("BOOTCLASSPATH")?.split(":")?.forEach { if (it.isNotBlank()) pathsToScan.add(it) }

        // 3. System Server Classpath
        System.getenv("SYSTEMSERVERCLASSPATH")?.split(":")?.forEach { if (it.isNotBlank()) pathsToScan.add(it) }

        if (pathsToScan.isEmpty()) {
            println("    └── Failed to locate any DEX paths to scan.")
            return
        }

        // Use our context class loader to resolve the found classes
        val contextLoader = ClassScanner::class.java.classLoader
        var found = false

        for (path in pathsToScan) {
            try {
                // Read the DEX file directly from the path
                val dexFile = DexFile(path)
                val entries = dexFile.entries()
                
                while (entries.hasMoreElements()) {
                    val className = entries.nextElement()
                    
                    try {
                        // Soft load the class without initializing static blocks
                        val loadedClass = Class.forName(className, false, contextLoader)
                        
                        // Check if it's a subclass but NOT the target class itself
                        if (targetClass.isAssignableFrom(loadedClass) && targetClass != loadedClass) {
                            println("    ├── ${loadedClass.name}")
                            found = true
                        }
                    } catch (e: Throwable) {
                        // Ignore classes that fail to resolve
                    }
                }
            } catch (e: Exception) {
                // Silently skip paths that cannot be parsed as valid DexFiles
            }
        }

        if (!found) {
            println("    └── No subclasses found in available DEX paths.")
            println("        (Note: On modern Android, system framework classes are often precompiled into")
            println("         .oat or .vdex files which strip raw .dex entries, limiting reflection visibility).")
        }
    }

    private fun printFields(clazz: Class<*>) {
        println("\n[+] DECLARED FIELDS (Properties)")
        val fields = clazz.declaredFields
        if (fields.isEmpty()) {
            println("    └── (None)")
            return
        }

        fields.forEach { field ->
            field.isAccessible = true
            val modifiers = Modifier.toString(field.modifiers)
            val type = field.type.simpleName
            println("    ├── $modifiers $type ${field.name}")
        }
    }

    private fun printConstructors(clazz: Class<*>) {
        println("\n[+] CONSTRUCTORS")
        val constructors = clazz.declaredConstructors
        if (constructors.isEmpty()) {
            println("    └── (None)")
            return
        }

        constructors.forEach { ctor ->
            val modifiers = Modifier.toString(ctor.modifiers)
            val params = ctor.parameterTypes.joinToString(", ") { it.simpleName }
            println("    ├── $modifiers ${clazz.simpleName}($params)")
        }
    }

    private fun printMethods(clazz: Class<*>) {
        println("\n[+] DECLARED METHODS")
        val methods = clazz.declaredMethods
        if (methods.isEmpty()) {
            println("    └── (None)")
            return
        }

        methods.forEach { method ->
            val modifiers = Modifier.toString(method.modifiers)
            val returnType = method.returnType.simpleName
            val params = method.parameterTypes.joinToString(", ") { it.simpleName }
            val exceptions = if (method.exceptionTypes.isNotEmpty()) {
                " throws " + method.exceptionTypes.joinToString(", ") { it.simpleName }
            } else ""

            println("    ├── $modifiers $returnType ${method.name}($params)$exceptions")
        }
        println("    └── [End of Methods]")
    }
}