import java.lang.reflect.Method;
import android.os.IBinder;
import android.os.Binder;

/**
 * This class can enable/disable the torch (flashlight) using the camera service.
 * Run like this:
 * <pre>
 * EnableTorch [off]
 * </pre>
 * If "off" is provided, it will turn off the torch; otherwise, it will turn it on.
 */

public class EnableTorch {
    private static final IBinder CLIENT_TOKEN = new Binder();

    public static void main(String[] args) {
        boolean enable = !(args.length>0 && args[0].equalsIgnoreCase("off"));

        try {
            // 1) Locate the camera service
            Class<?> smClass = Class.forName("android.os.ServiceManager");
            Method getService = smClass.getMethod("getService", String.class);
            Object cameraBinder = getService.invoke(null, "camera");
            if (cameraBinder == null) {
                cameraBinder = getService.invoke(null, "media.camera");
            }
            if (cameraBinder == null) {
                throw new IllegalStateException("Camera service not found");
            }

            // 2) AsInterface → ICameraService
            Class<?> stub = Class.forName("android.hardware.ICameraService$Stub");
            Method asInterface = stub.getMethod("asInterface", Class.forName("android.os.IBinder"));
            Object cameraService = asInterface.invoke(null, cameraBinder);

            // 3) Pick the right setTorchMode method
            Method torchMethod = null;
            for (Method m : cameraService.getClass().getMethods()) {
                if (m.getName().startsWith("setTorchMode")) {
                    int pc = m.getParameterCount();
                    if (pc == 2 || pc == 3) {
                        torchMethod = m;
                        break;
                    }
                }
            }
            if (torchMethod == null) {
                throw new NoSuchMethodException("No suitable setTorchMode method found");
            }

            // 4) Prepare args
            String cameraId = "0";  // adjust for your device
            Object[] invokeArgs;
            if (torchMethod.getParameterCount() == 2) {
                invokeArgs = new Object[]{ cameraId, enable };
            } else {
                invokeArgs = new Object[]{ cameraId, enable, CLIENT_TOKEN };
            }

            // 5) Invoke it
            torchMethod.invoke(cameraService, invokeArgs);
            System.out.println("Torch " + (enable ? "ENABLED" : "DISABLED"));

            if (enable) {
                // **BLOCK** here so process (and CLIENT_TOKEN) stay alive.
                System.out.println("Process is now holding the torch ON. Run again with “off” to disable.");
                synchronized (CLIENT_TOKEN) {
                    CLIENT_TOKEN.wait();  // wait forever
                }
            }

            // if disabling, just exit
            System.exit(0);

        } catch (Throwable t) {
            System.err.println("Failed to toggle torch:");
            t.printStackTrace();
            System.exit(2);
        }
    }
}
