package space.companion.mobile;

import java.net.URI;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class MobileOriginPolicy {
    private static final Pattern ISO_FRACTION = Pattern.compile("(\\.\\d{1,})(Z|[+-]\\d{2}:\\d{2})$");
    private MobileOriginPolicy() {}

    static boolean isValidServerOrigin(String value) {
        if (value == null) return false;
        try {
            URI uri = URI.create(value);
            boolean secure = "https".equals(uri.getScheme());
            boolean devLoopback = "http".equals(uri.getScheme()) && ("localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()) || "::1".equals(uri.getHost()));
            boolean defaultPort = uri.getPort() == -1 || (secure && uri.getPort() == 443);
            return (secure || devLoopback) && defaultPort && uri.getHost() != null && uri.getUserInfo() == null
                    && (uri.getPath() == null || uri.getPath().isEmpty()) && uri.getQuery() == null && uri.getFragment() == null;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static boolean isSameOrigin(String approvedValue, String currentValue) {
        try {
            URI approved = URI.create(approvedValue);
            URI current = URI.create(currentValue);
            return approved.getScheme().equals(current.getScheme())
                    && approved.getHost().equals(current.getHost())
                    && approved.getPort() == current.getPort();
        } catch (IllegalArgumentException | NullPointerException error) {
            return false;
        }
    }

    static long parseIsoEpochMs(String value) throws Exception {
        Matcher matcher = ISO_FRACTION.matcher(value);
        String normalized = value;
        String pattern = "yyyy-MM-dd'T'HH:mm:ssXXX";
        if (matcher.find()) {
            String fraction = matcher.group(1).substring(1);
            String millis = (fraction + "000").substring(0, 3);
            normalized = value.substring(0, matcher.start()) + "." + millis + matcher.group(2);
            pattern = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX";
        }
        SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.ROOT);
        parser.setLenient(false);
        parser.setTimeZone(TimeZone.getTimeZone("UTC"));
        Date parsed = parser.parse(normalized);
        if (parsed == null) throw new IllegalArgumentException("Invalid expiry");
        return parsed.getTime();
    }
}
