import XCTest
@testable import App

final class MobileAuthPolicyTests: XCTestCase {
    func testAcceptsProductionAndLoopbackOrigins() {
        XCTAssertTrue(MobileAuthPolicy.isValidServerOrigin("https://companion.example"))
        XCTAssertTrue(MobileAuthPolicy.isValidServerOrigin("https://companion.example:443"))
        XCTAssertTrue(MobileAuthPolicy.isValidServerOrigin("http://localhost"))
        XCTAssertTrue(MobileAuthPolicy.isValidServerOrigin("http://127.0.0.1"))
        XCTAssertTrue(MobileAuthPolicy.isValidServerOrigin("http://[::1]"))
    }

    func testRejectsNonOriginOrInsecureServerValues() {
        for value in [
            "http://companion.example",
            "https://companion.example:8443",
            "http://localhost:8100",
            "https://user:pass@companion.example",
            "https://companion.example/path",
            "https://companion.example?query=1",
            "https://companion.example#fragment",
        ] {
            XCTAssertFalse(MobileAuthPolicy.isValidServerOrigin(value), value)
        }
    }

    func testAuthorizedPageMustMatchExactOrigin() {
        let approved = "https://companion.example"
        XCTAssertTrue(MobileAuthPolicy.isSameOrigin(
            current: URL(string: "https://companion.example/spaces/one"), approvedText: approved
        ))
        XCTAssertFalse(MobileAuthPolicy.isSameOrigin(
            current: URL(string: "https://attacker.example"), approvedText: approved
        ))
        XCTAssertFalse(MobileAuthPolicy.isSameOrigin(
            current: URL(string: "http://companion.example"), approvedText: approved
        ))
        XCTAssertFalse(MobileAuthPolicy.isSameOrigin(
            current: URL(string: "https://companion.example:8443"), approvedText: approved
        ))
    }

    func testRefreshResultRequiresCurrentGenerationOriginAndPage() {
        let origin = "https://companion.example"
        let current = URL(string: "https://companion.example/session")
        XCTAssertTrue(MobileAuthPolicy.isCurrentRefresh(
            operationGeneration: 7, currentGeneration: 7, operationOrigin: origin,
            authorizedOrigin: origin, currentURL: current
        ))
        XCTAssertFalse(MobileAuthPolicy.isCurrentRefresh(
            operationGeneration: 7, currentGeneration: 8, operationOrigin: origin,
            authorizedOrigin: origin, currentURL: current
        ))
        XCTAssertFalse(MobileAuthPolicy.isCurrentRefresh(
            operationGeneration: 7, currentGeneration: 7, operationOrigin: origin,
            authorizedOrigin: nil, currentURL: current
        ))
        XCTAssertFalse(MobileAuthPolicy.isCurrentRefresh(
            operationGeneration: 7, currentGeneration: 7, operationOrigin: origin,
            authorizedOrigin: origin, currentURL: URL(string: "https://attacker.example")
        ))
    }
}
