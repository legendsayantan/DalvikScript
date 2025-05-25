import android.os.Build;
import java.lang.reflect.Method;
import java.lang.reflect.InvocationTargetException;
import android.os.IBinder;

/**
 * This class sets the display power mode of the built-in display, which can be used to turn the display on or off.
 * Run like this:
 * <pre>
 * SetDisplayPowerMode <mode>[0 for off, 1 for on, 2 for doze]
 * </pre>
 */
public class SetDisplayPowerMode {

    private static final Class<?> CLASS;
	static {
        	try {
            		CLASS = Class.forName("android.view.SurfaceControl");
		} catch (ClassNotFoundException e) {
        	throw new AssertionError(e);
     	 }
    }

    public static void main(String... args) throws Exception {
	System.out.print("Display mode: "+args[0]);
	Method method = CLASS.getMethod("setDisplayPowerMode", IBinder.class, int.class);
	try {
            method.invoke(null, getBuiltInDisplay(),Integer.parseInt(args[0]));
        } catch (InvocationTargetException | IllegalAccessException e) {
	    e.printStackTrace();
        }
    }

    private static Method getGetBuiltInDisplayMethod() throws NoSuchMethodException {
       Method getBuiltInDisplayMethod;
            // the method signature has changed in Android Q
            // <https://github.com/Genymobile/scrcpy/issues/586>
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                getBuiltInDisplayMethod = CLASS.getMethod("getBuiltInDisplay", int.class);
            } else {
                getBuiltInDisplayMethod = CLASS.getMethod("getInternalDisplayToken");
            }
        return getBuiltInDisplayMethod;
    }

    public static IBinder getBuiltInDisplay() {
        try {
            Method method = getGetBuiltInDisplayMethod();
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                // call getBuiltInDisplay(0)
                return (IBinder) method.invoke(null, 0);
            }
            // call getInternalDisplayToken()
            return (IBinder) method.invoke(null);
           } catch (InvocationTargetException | IllegalAccessException | NoSuchMethodException e) {
            e.printStackTrace();
            return null;
        }
    }
}