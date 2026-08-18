package space.companion.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CompanionAuthPluginTest {
    @Test
    public void acceptsOnlySecureOriginsAndExplicitLoopbackDevelopment() {
        assertTrue(MobileOriginPolicy.isValidServerOrigin("https://companion.example.com"));
        assertTrue(MobileOriginPolicy.isValidServerOrigin("https://companion.example.com:443"));
        assertFalse(MobileOriginPolicy.isValidServerOrigin("https://companion.example.com:8443"));
        assertTrue(MobileOriginPolicy.isValidServerOrigin("http://127.0.0.1"));
        assertFalse(MobileOriginPolicy.isValidServerOrigin("http://127.0.0.1:3000"));
        assertFalse(MobileOriginPolicy.isValidServerOrigin("http://companion.example.com"));
        assertFalse(MobileOriginPolicy.isValidServerOrigin("https://user:pass@companion.example.com"));
        assertFalse(MobileOriginPolicy.isValidServerOrigin("https://companion.example.com/path"));
    }

    @Test
    public void accessTokenOriginRequiresExactSchemeHostAndPort() {
        String approved = "https://companion.example.com";
        assertTrue(MobileOriginPolicy.isSameOrigin(approved, "https://companion.example.com/spaces/one"));
        assertFalse(MobileOriginPolicy.isSameOrigin(approved, "https://companion.example.com:8443/spaces/one"));
        assertFalse(MobileOriginPolicy.isSameOrigin(approved, "http://companion.example.com/spaces/one"));
        assertFalse(MobileOriginPolicy.isSameOrigin(approved, "https://other.example.com/spaces/one"));
    }

    @Test
    public void parsesServerExpiryWithOrWithoutFractionalSeconds() throws Exception {
        assertTrue(MobileOriginPolicy.parseIsoEpochMs("2030-01-02T03:04:05Z") > 0);
        assertTrue(MobileOriginPolicy.parseIsoEpochMs("2030-01-02T03:04:05.123456+00:00") > 0);
    }

    @Test
    public void refreshGateSharesOneActiveOperationUntilItFinishes() {
        AuthRefreshGate<Object> gate = new AuthRefreshGate<>();
        Object operation = new Object();
        long generation = gate.generation();

        gate.setActive(operation);

        assertSame(operation, gate.active());
        assertTrue(gate.isCurrent(generation, operation));
        gate.detach(operation);
        assertNull(gate.active());
        assertFalse(gate.isCurrent(generation, operation));
    }

    @Test
    public void refreshGateInvalidationMakesLateOperationStale() {
        AuthRefreshGate<Object> gate = new AuthRefreshGate<>();
        Object operation = new Object();
        long generation = gate.generation();
        gate.setActive(operation);

        assertSame(operation, gate.invalidate());

        assertNull(gate.active());
        assertFalse(gate.isCurrent(generation, operation));
        Object replacement = new Object();
        gate.setActive(replacement);
        assertTrue(gate.isCurrent(gate.generation(), replacement));
        assertFalse(gate.isCurrent(generation, operation));
    }

    @Test
    public void invalidatedOperationCannotSnapshotReplacementCredentialOrStartRequest() {
        AuthRefreshGate<Object> gate = new AuthRefreshGate<>();
        Object oldOperation = new Object();
        long oldGeneration = gate.generation();
        gate.setActive(oldOperation);

        gate.invalidate();
        Object replacementOperation = new Object();
        gate.setActive(replacementOperation);
        int requestsStarted = 0;
        if (gate.isCurrent(oldGeneration, oldOperation)) requestsStarted++;

        assertTrue(gate.isCurrent(gate.generation(), replacementOperation));
        assertFalse(gate.isCurrent(oldGeneration, oldOperation));
        assertTrue(requestsStarted == 0);
    }
}
