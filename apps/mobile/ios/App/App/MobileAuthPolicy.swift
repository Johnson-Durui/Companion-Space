import Foundation

enum MobileAuthPolicy {
    static func isValidServerOrigin(_ value: String) -> Bool {
        guard let components = URLComponents(string: value) else { return false }
        let loopback = components.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(components.host ?? "")
        let defaultPort = components.port == nil || (components.scheme == "https" && components.port == 443)
        return (components.scheme == "https" || loopback) && defaultPort && components.host != nil
            && components.user == nil && components.password == nil
            && (components.path.isEmpty || components.path == "/") && components.query == nil && components.fragment == nil
    }

    static func isSameOrigin(current: URL?, approvedText: String?) -> Bool {
        guard let current, let approvedText,
              let approved = URLComponents(string: approvedText) else { return false }
        return current.scheme == approved.scheme && current.host == approved.host && current.port == approved.port
    }

    static func isCurrentRefresh(
        operationGeneration: UInt64,
        currentGeneration: UInt64,
        operationOrigin: String,
        authorizedOrigin: String?,
        currentURL: URL?
    ) -> Bool {
        operationGeneration == currentGeneration && authorizedOrigin == operationOrigin
            && isSameOrigin(current: currentURL, approvedText: operationOrigin)
    }
}
