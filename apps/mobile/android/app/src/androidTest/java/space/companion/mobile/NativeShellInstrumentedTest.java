package space.companion.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.PluginHandle;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Arrays;

@RunWith(AndroidJUnit4.class)
public class NativeShellInstrumentedTest {

    @Test
    public void launchesMainActivity() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> assertEquals(MainActivity.class, activity.getClass()));
        }
    }

    @Test
    public void createsCapacitorWebViewWhenMainActivityLaunches() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertNotNull(activity.getBridge());
                assertTrue(activity.getBridge().getWebView() instanceof WebView);
            });
        }
    }

    @Test
    public void registersCompanionAuthBridgeWhenMainActivityLaunches() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                PluginHandle plugin = activity.getBridge().getPlugin("CompanionAuth");

                assertNotNull(plugin);
                assertEquals(CompanionAuthPlugin.class, plugin.getPluginClass());
            });
        }
    }

    @Test
    public void declaresRecordAudioPermission() throws PackageManager.NameNotFoundException {
        assertManifestDeclares(Manifest.permission.RECORD_AUDIO);
    }

    @Test
    public void declaresModifyAudioSettingsPermission() throws PackageManager.NameNotFoundException {
        assertManifestDeclares(Manifest.permission.MODIFY_AUDIO_SETTINGS);
    }

    private static void assertManifestDeclares(String permission) throws PackageManager.NameNotFoundException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo packageInfo = context
            .getPackageManager()
            .getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);

        assertNotNull(packageInfo.requestedPermissions);
        assertTrue(Arrays.asList(packageInfo.requestedPermissions).contains(permission));
    }
}
