package space.companion.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "CompanionAuth")
public class CompanionAuthPlugin extends Plugin {
    private static final int HTTP_TIMEOUT_MS = 10_000;
    private static final int MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
    private static final String KEY_ALIAS = "companion_space_mobile_refresh_v1";
    private static final String PREFS = "companion_space_mobile_secure_auth";
    private static final String REFRESH = "refresh";
    private static final String ROTATION = "rotation";
    private volatile String accessToken;
    private volatile String accessTokenExpiresAt;
    private volatile long accessTokenExpiresAtEpochMs;
    private volatile String authorizedOrigin;
    private final Object authLock = new Object();
    private final AuthRefreshGate<RefreshOperation> refreshGate = new AuthRefreshGate<>();

    private static final class RefreshOperation {
        final long generation;
        final String origin;
        final List<PluginCall> calls = new ArrayList<>();

        RefreshOperation(long generation, String origin, PluginCall call) {
            this.generation = generation;
            this.origin = origin;
            calls.add(call);
        }
    }


    @PluginMethod
    public void persistAuth(PluginCall call) {
        if (!isLocalLauncher()) {
            call.reject("Mobile auth persistence is restricted to the local launcher");
            return;
        }
        String refreshToken = call.getString("refreshToken");
        String nextAccessToken = call.getString("accessToken");
        String expiresAt = call.getString("accessTokenExpiresAt");
        Long expiresAtEpochMs = call.getLong("accessTokenExpiresAtEpochMs");
        String rotationId = call.getString("rotationId");
        String serverOrigin = call.getString("serverOrigin");
        if (refreshToken == null || refreshToken.length() < 32 || nextAccessToken == null || expiresAt == null || expiresAtEpochMs == null || !isValidHttpsOrigin(serverOrigin)) {
            call.reject("Invalid mobile auth payload");
            return;
        }
        try {
            String encryptedRefresh = encrypt(refreshToken);
            String encryptedRotation = rotationId == null || rotationId.isBlank() ? null : encrypt(rotationId);
            RefreshOperation stale;
            synchronized (authLock) {
                SharedPreferences.Editor editor = prefs().edit().putString(REFRESH, encryptedRefresh);
                if (encryptedRotation == null) editor.remove(ROTATION);
                else editor.putString(ROTATION, encryptedRotation);
                if (!editor.commit()) throw new IllegalStateException("Secure auth commit failed");
                stale = invalidateRefreshLocked();
                accessToken = nextAccessToken;
                accessTokenExpiresAt = expiresAt;
                accessTokenExpiresAtEpochMs = expiresAtEpochMs;
                authorizedOrigin = serverOrigin;
            }
            rejectCalls(stale, "Mobile auth changed while access was refreshing", "AUTH_REVOKED");
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to store mobile auth", error);
        }
    }

    @PluginMethod
    public void getRefreshToken(PluginCall call) {
        if (!isLocalLauncher()) {
            call.reject("Refresh credentials are restricted to the local launcher");
            return;
        }
        JSObject result = new JSObject();
        try {
            result.put("value", decryptNullable(prefs().getString(REFRESH, null)));
            result.put("rotationId", decryptNullable(prefs().getString(ROTATION, null)));
            call.resolve(result);
        } catch (Exception error) {
            clearStoredAuth();
            call.reject("Unable to read mobile auth", error);
        }
    }

    @PluginMethod
    public void getAccessToken(PluginCall call) {
        JSObject result = new JSObject();
        RefreshOperation stale = null;
        boolean unauthorized;
        synchronized (authLock) {
            unauthorized = !isAuthorizedRemotePageLocked(authorizedOrigin);
            if (!unauthorized && accessToken != null && accessTokenExpiresAt != null && accessTokenExpiresAtEpochMs > System.currentTimeMillis()) {
                result.put("value", accessToken);
                result.put("expiresAt", accessTokenExpiresAt);
            } else if (!unauthorized) {
                stale = clearAccessTokenStateLocked(false);
                result.put("value", JSObject.NULL);
                result.put("expiresAt", JSObject.NULL);
            }
        }
        if (unauthorized) {
            call.reject("Access token is restricted to the authorized server");
            return;
        }
        rejectCalls(stale, "Mobile access refresh was cancelled", "AUTH_REVOKED");
        call.resolve(result);
    }

    @PluginMethod
    public void refreshAccessToken(PluginCall call) {
        if (!isAuthorizedRemotePage()) {
            call.reject("Access refresh is restricted to the authorized server", "AUTH_REVOKED");
            return;
        }
        final RefreshOperation operation;
        synchronized (authLock) {
            String approvedOrigin = authorizedOrigin;
            if (!isAuthorizedRemotePageLocked(approvedOrigin)) {
                call.reject("Access refresh is restricted to the authorized server", "AUTH_REVOKED");
                return;
            }
            RefreshOperation active = refreshGate.active();
            if (active != null
                    && active.generation == refreshGate.generation()
                    && Objects.equals(active.origin, approvedOrigin)) {
                active.calls.add(call);
                return;
            }
            operation = new RefreshOperation(refreshGate.generation(), approvedOrigin, call);
            refreshGate.setActive(operation);
        }
        execute(() -> refreshAccessTokenInBackground(operation));
    }

    @PluginMethod
    public void clearAccessToken(PluginCall call) {
        if (!isAuthorizedRemotePage()) {
            call.reject("Access-token clearing is restricted to the authorized server");
            return;
        }
        RefreshOperation stale = clearAccessTokenState(true);
        rejectCalls(stale, "Mobile access refresh was cancelled", "AUTH_REVOKED");
        call.resolve();
    }

    @PluginMethod
    public void returnToLauncher(PluginCall call) {
        if (!isAuthorizedRemotePage()) {
            call.reject("Launcher return is restricted to the authorized server");
            return;
        }
        RefreshOperation stale = clearAccessTokenState(true);
        rejectCalls(stale, "Mobile access refresh was cancelled", "AUTH_REVOKED");
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(getBridge().getLocalUrl()));
        call.resolve();
    }

    @PluginMethod
    public void clearAuth(PluginCall call) {
        if (!isLocalLauncher()) {
            call.reject("Full mobile unpairing is restricted to the local launcher");
            return;
        }
        clearStoredAuth();
        call.resolve();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean isLocalLauncher() {
        String currentUrl = getBridge().getWebView().getUrl();
        return currentUrl != null && currentUrl.startsWith("https://app.companion.local/");
    }

    private boolean isValidHttpsOrigin(String value) {
        return MobileOriginPolicy.isValidServerOrigin(value);
    }

    private boolean isAuthorizedRemotePage() {
        synchronized (authLock) {
            return isAuthorizedRemotePageLocked(authorizedOrigin);
        }
    }

    private boolean isAuthorizedRemotePageLocked(String approvedOrigin) {
        String currentUrl = getBridge().getWebView().getUrl();
        return currentUrl != null && approvedOrigin != null && MobileOriginPolicy.isSameOrigin(approvedOrigin, currentUrl);
    }

    private void refreshAccessTokenInBackground(RefreshOperation operation) {
        HttpURLConnection connection = null;
        try {
            String refreshToken = null;
            List<PluginCall> staleCalls = null;
            synchronized (authLock) {
                if (!isCurrentRefreshLocked(operation)) {
                    staleCalls = detachCallsLocked(operation);
                } else {
                    refreshToken = decryptNullable(prefs().getString(REFRESH, null));
                }
            }
            if (staleCalls != null) {
                rejectCalls(staleCalls, "Mobile auth changed while access was refreshing", "AUTH_REVOKED", null);
                return;
            }
            if (refreshToken == null || refreshToken.length() < 32) {
                List<PluginCall> calls = revokeAndReturnToLauncherIfCurrent(operation);
                rejectCalls(calls, "Mobile refresh credential is missing", "AUTH_REVOKED", null);
                return;
            }
            URL endpoint = new URL(operation.origin + "/api/v1/mobile/auth/refresh");
            connection = (HttpURLConnection) endpoint.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(HTTP_TIMEOUT_MS);
            connection.setReadTimeout(HTTP_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] requestBody = new JSONObject().put("refresh_token", refreshToken).toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(requestBody.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(requestBody);
            }
            refreshToken = null;

            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED) {
                List<PluginCall> calls = revokeAndReturnToLauncherIfCurrent(operation);
                rejectCalls(calls, "Mobile refresh credential was revoked", "AUTH_REVOKED", null);
                return;
            }
            if (status != HttpURLConnection.HTTP_OK) {
                finishWithError(operation, "Mobile access refresh failed with HTTP " + status, "AUTH_RETRYABLE", null);
                return;
            }
            String responseText = readLimited(connection.getInputStream());
            JSONObject response = new JSONObject(responseText);
            String nextRefresh = response.optString("refresh_token", "");
            String nextAccess = response.optString("access_token", "");
            String expiresAt = response.optString("access_token_expires_at", "");
            long expiresAtEpochMs = MobileOriginPolicy.parseIsoEpochMs(expiresAt);
            if (nextRefresh.length() < 32 || nextAccess.length() < 20 || expiresAtEpochMs <= System.currentTimeMillis()) {
                finishWithError(operation, "Mobile access refresh returned an invalid response", "AUTH_RETRYABLE", null);
                return;
            }
            String encryptedRefresh = encrypt(nextRefresh);
            nextRefresh = null;
            JSObject result = new JSObject();
            result.put("value", nextAccess);
            result.put("expiresAt", expiresAt);
            synchronized (authLock) {
                if (!isCurrentRefreshLocked(operation)) {
                    rejectCalls(detachCallsLocked(operation), "Mobile auth changed while access was refreshing", "AUTH_REVOKED", null);
                    return;
                }
                if (!prefs().edit().putString(REFRESH, encryptedRefresh).commit()) {
                    rejectCalls(detachCallsLocked(operation), "Unable to persist rotated mobile credential", "AUTH_RETRYABLE", null);
                    return;
                }
                accessToken = nextAccess;
                accessTokenExpiresAt = expiresAt;
                accessTokenExpiresAtEpochMs = expiresAtEpochMs;
                resolveCalls(detachCallsLocked(operation), result);
            }
        } catch (Exception error) {
            finishWithError(operation, "Mobile access refresh is temporarily unavailable", "AUTH_RETRYABLE", error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readLimited(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > MAX_AUTH_RESPONSE_BYTES) throw new IllegalStateException("Auth response too large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private List<PluginCall> revokeAndReturnToLauncherIfCurrent(RefreshOperation operation) {
        List<PluginCall> calls;
        synchronized (authLock) {
            if (!isCurrentRefreshLocked(operation)) return detachCallsLocked(operation);
            prefs().edit().clear().commit();
            calls = drainCalls(clearAccessTokenStateLocked(true));
        }
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(getBridge().getLocalUrl()));
        return calls;
    }

    private void clearStoredAuth() {
        RefreshOperation stale;
        synchronized (authLock) {
            prefs().edit().clear().commit();
            stale = clearAccessTokenStateLocked(true);
        }
        rejectCalls(stale, "Mobile auth was cleared", "AUTH_REVOKED");
    }

    private RefreshOperation clearAccessTokenState(boolean clearOrigin) {
        synchronized (authLock) {
            return clearAccessTokenStateLocked(clearOrigin);
        }
    }

    private RefreshOperation clearAccessTokenStateLocked(boolean clearOrigin) {
        RefreshOperation stale = invalidateRefreshLocked();
        accessToken = null;
        accessTokenExpiresAt = null;
        accessTokenExpiresAtEpochMs = 0;
        if (clearOrigin) authorizedOrigin = null;
        return stale;
    }

    private RefreshOperation invalidateRefreshLocked() {
        return refreshGate.invalidate();
    }

    private boolean isCurrentRefreshLocked(RefreshOperation operation) {
        return refreshGate.isCurrent(operation.generation, operation)
                && Objects.equals(authorizedOrigin, operation.origin)
                && isAuthorizedRemotePageLocked(operation.origin);
    }

    private List<PluginCall> detachCallsLocked(RefreshOperation operation) {
        refreshGate.detach(operation);
        List<PluginCall> calls = new ArrayList<>(operation.calls);
        operation.calls.clear();
        return calls;
    }

    private void finishWithError(RefreshOperation operation, String message, String code, Exception error) {
        List<PluginCall> calls;
        synchronized (authLock) {
            calls = detachCallsLocked(operation);
        }
        rejectCalls(calls, message, code, error);
    }

    private void resolveCalls(List<PluginCall> calls, JSObject result) {
        for (PluginCall call : calls) call.resolve(result);
    }

    private void rejectCalls(RefreshOperation operation, String message, String code) {
        rejectCalls(drainCalls(operation), message, code, null);
    }

    private List<PluginCall> drainCalls(RefreshOperation operation) {
        if (operation == null) return new ArrayList<>();
        List<PluginCall> calls = new ArrayList<>(operation.calls);
        operation.calls.clear();
        return calls;
    }

    private void rejectCalls(List<PluginCall> calls, String message, String code, Exception error) {
        for (PluginCall call : calls) {
            if (error == null) call.reject(message, code);
            else call.reject(message, code, error);
        }
    }

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String body = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        return iv + "." + body;
    }

    private String decryptNullable(String encoded) throws Exception {
        if (encoded == null) return null;
        String[] parts = encoded.split("\\.", 2);
        if (parts.length != 2) throw new IllegalStateException("Invalid encrypted auth payload");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}

final class AuthRefreshGate<T> {
    private long generation;
    private T active;

    long generation() {
        return generation;
    }

    T active() {
        return active;
    }

    void setActive(T value) {
        active = value;
    }

    T invalidate() {
        generation++;
        T stale = active;
        active = null;
        return stale;
    }

    boolean isCurrent(long candidateGeneration, T candidate) {
        return generation == candidateGeneration && active == candidate;
    }

    void detach(T candidate) {
        if (active == candidate) active = null;
    }
}
