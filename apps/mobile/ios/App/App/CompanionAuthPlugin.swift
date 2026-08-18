import Foundation
import Security
import Capacitor

private final class NoRedirectSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private final class RefreshOperation {
    let generation: UInt64
    let origin: String
    var calls: [CAPPluginCall]

    init(generation: UInt64, origin: String, call: CAPPluginCall) {
        self.generation = generation
        self.origin = origin
        self.calls = [call]
    }
}

@objc(CompanionAuthPlugin)
public class CompanionAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CompanionAuthPlugin"
    public let jsName = "CompanionAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "persistAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRefreshToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "returnToLauncher", returnType: CAPPluginReturnPromise),
    ]

    private let service = "space.companion.mobile.auth"
    private let refreshAccount = "refresh-token-v1"
    private let rotationAccount = "rotation-id-v1"
    private var accessToken: String?
    private var accessTokenExpiresAt: String?
    private var authorizedOrigin: String?
    private let lock = NSLock()
    private var authGeneration: UInt64 = 0
    private var refreshOperation: RefreshOperation?

    @objc func persistAuth(_ call: CAPPluginCall) {
        guard isLocalLauncher else {
            call.reject("Mobile auth persistence is restricted to the local launcher")
            return
        }
        guard let refreshToken = call.getString("refreshToken"), refreshToken.count >= 32,
              let nextAccessToken = call.getString("accessToken"),
              let expiresAt = call.getString("accessTokenExpiresAt"),
              let serverOrigin = call.getString("serverOrigin"), MobileAuthPolicy.isValidServerOrigin(serverOrigin),
              Self.parseISODate(expiresAt) != nil else {
            call.reject("Invalid mobile auth payload")
            return
        }
        do {
            let staleCalls: [CAPPluginCall]
            lock.lock()
            do {
                try writeKeychain(account: refreshAccount, value: refreshToken)
                if let rotationId = call.getString("rotationId"), !rotationId.isEmpty {
                    try writeKeychain(account: rotationAccount, value: rotationId)
                } else {
                    deleteKeychain(account: rotationAccount)
                }
                staleCalls = invalidateRefreshLocked()
                accessToken = nextAccessToken
                accessTokenExpiresAt = expiresAt
                authorizedOrigin = serverOrigin
                lock.unlock()
            } catch {
                lock.unlock()
                throw error
            }
            reject(calls: staleCalls, message: "Mobile auth changed while access was refreshing", code: "AUTH_REVOKED")
            call.resolve()
        } catch {
            call.reject("Unable to store mobile auth", nil, error)
        }
    }

    @objc func getRefreshToken(_ call: CAPPluginCall) {
        guard isLocalLauncher else {
            call.reject("Refresh credentials are restricted to the local launcher")
            return
        }
        do {
            let refresh = try readKeychain(account: refreshAccount)
            let rotation = try readKeychain(account: rotationAccount)
            call.resolve(["value": refresh.map { $0 as Any } ?? NSNull(),
                          "rotationId": rotation.map { $0 as Any } ?? NSNull()])
        } catch {
            clearStoredAuth()
            call.reject("Unable to read mobile auth", nil, error)
        }
    }

    @objc func getAccessToken(_ call: CAPPluginCall) {
        lock.lock()
        guard isAuthorizedRemotePageLocked(origin: authorizedOrigin) else {
            lock.unlock()
            call.reject("Access token is restricted to the authorized server")
            return
        }
        let expiry = accessTokenExpiresAt.flatMap { Self.parseISODate($0) }
        guard let token = accessToken, let expiresAt = accessTokenExpiresAt, let expiry, expiry > Date() else {
            let staleCalls = clearAccessTokenStateLocked(clearOrigin: false)
            lock.unlock()
            reject(calls: staleCalls, message: "Mobile access refresh was cancelled", code: "AUTH_REVOKED")
            call.resolve(["value": NSNull(), "expiresAt": NSNull()])
            return
        }
        lock.unlock()
        call.resolve(["value": token, "expiresAt": expiresAt])
    }

    @objc func refreshAccessToken(_ call: CAPPluginCall) {
        lock.lock()
        guard let approvedOrigin = authorizedOrigin, isAuthorizedRemotePageLocked(origin: approvedOrigin) else {
            lock.unlock()
            call.reject("Access refresh is restricted to the authorized server", "AUTH_REVOKED")
            return
        }
        if let active = refreshOperation, active.generation == authGeneration, active.origin == approvedOrigin {
            active.calls.append(call)
            lock.unlock()
            return
        }
        let operation = RefreshOperation(generation: authGeneration, origin: approvedOrigin, call: call)
        refreshOperation = operation
        let refreshToken: String
        do {
            guard let stored = try readKeychain(account: refreshAccount), stored.count >= 32 else {
                deleteKeychain(account: refreshAccount)
                deleteKeychain(account: rotationAccount)
                let calls = clearAccessTokenStateLocked(clearOrigin: true)
                lock.unlock()
                returnToLocalLauncher()
                reject(calls: calls, message: "Mobile refresh credential is missing", code: "AUTH_REVOKED")
                return
            }
            refreshToken = stored
        } catch {
            let calls = detachCallsLocked(operation)
            lock.unlock()
            reject(calls: calls, message: "Mobile access refresh is temporarily unavailable", code: "AUTH_RETRYABLE", error: error)
            return
        }
        lock.unlock()
        guard var endpoint = URLComponents(string: approvedOrigin) else {
            finish(operation: operation, message: "Unable to construct mobile refresh request", code: "AUTH_RETRYABLE")
            return
        }
        endpoint.path = "/api/v1/mobile/auth/refresh"
        endpoint.query = nil
        endpoint.fragment = nil
        guard let url = endpoint.url,
              let body = try? JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken]) else {
            finish(operation: operation, message: "Unable to construct mobile refresh request", code: "AUTH_RETRYABLE")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: NoRedirectSessionDelegate(), delegateQueue: nil)
        session.dataTask(with: request) { [weak self] data, response, error in
            defer { session.finishTasksAndInvalidate() }
            guard let self else { return }
            if let error {
                self.finish(operation: operation, message: "Mobile access refresh is temporarily unavailable", code: "AUTH_RETRYABLE", error: error)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                self.finish(operation: operation, message: "Mobile access refresh returned no HTTP response", code: "AUTH_RETRYABLE")
                return
            }
            if http.statusCode == 401 {
                let calls = self.revokeAndReturnToLauncherIfCurrent(operation)
                self.reject(calls: calls, message: "Mobile refresh credential was revoked", code: "AUTH_REVOKED")
                return
            }
            guard http.statusCode == 200 else {
                self.finish(operation: operation, message: "Mobile access refresh failed with HTTP \(http.statusCode)", code: "AUTH_RETRYABLE")
                return
            }
            guard let data, data.count <= 64 * 1024,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let nextRefresh = json["refresh_token"] as? String, nextRefresh.count >= 32,
                  let nextAccess = json["access_token"] as? String, nextAccess.count >= 20,
                  let expiresAt = json["access_token_expires_at"] as? String,
                  let expiry = Self.parseISODate(expiresAt), expiry > Date() else {
                self.finish(operation: operation, message: "Mobile access refresh returned an invalid response", code: "AUTH_RETRYABLE")
                return
            }
            self.lock.lock()
            guard self.isCurrentRefreshLocked(operation) else {
                let calls = self.detachCallsLocked(operation)
                self.lock.unlock()
                self.reject(calls: calls, message: "Mobile auth changed while access was refreshing", code: "AUTH_REVOKED")
                return
            }
            do {
                try self.writeKeychain(account: self.refreshAccount, value: nextRefresh)
                self.accessToken = nextAccess
                self.accessTokenExpiresAt = expiresAt
                let calls = self.detachCallsLocked(operation)
                for pending in calls { pending.resolve(["value": nextAccess, "expiresAt": expiresAt]) }
                self.lock.unlock()
            } catch {
                let calls = self.detachCallsLocked(operation)
                self.lock.unlock()
                self.reject(calls: calls, message: "Unable to persist rotated mobile credential", code: "AUTH_RETRYABLE", error: error)
            }
        }.resume()
    }

    @objc func clearAccessToken(_ call: CAPPluginCall) {
        guard isAuthorizedRemotePage else {
            call.reject("Access-token clearing is restricted to the authorized server")
            return
        }
        let staleCalls = clearAccessTokenState(clearOrigin: true)
        reject(calls: staleCalls, message: "Mobile access refresh was cancelled", code: "AUTH_REVOKED")
        call.resolve()
    }

    @objc func returnToLauncher(_ call: CAPPluginCall) {
        guard isAuthorizedRemotePage, let localURL = bridge?.config.localURL else {
            call.reject("Launcher return is restricted to the authorized server")
            return
        }
        let staleCalls = clearAccessTokenState(clearOrigin: true)
        reject(calls: staleCalls, message: "Mobile access refresh was cancelled", code: "AUTH_REVOKED")
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.load(URLRequest(url: localURL))
        }
        call.resolve()
    }

    @objc func clearAuth(_ call: CAPPluginCall) {
        guard isLocalLauncher else {
            call.reject("Full mobile unpairing is restricted to the local launcher")
            return
        }
        clearStoredAuth()
        call.resolve()
    }

    private func keychainQuery(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private var isLocalLauncher: Bool {
        bridge?.webView?.url?.scheme == "capacitor" && bridge?.webView?.url?.host == "app.companion.local"
    }

    private var isAuthorizedRemotePage: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isAuthorizedRemotePageLocked(origin: authorizedOrigin)
    }

    private func isAuthorizedRemotePageLocked(origin: String?) -> Bool {
        MobileAuthPolicy.isSameOrigin(current: bridge?.webView?.url, approvedText: origin)
    }

    private func writeKeychain(account: String, value: String) throws {
        let query = keychainQuery(account: account)
        let data = Data(value.utf8)
        let updateStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(updateStatus))
        }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(insertStatus)) }
    }

    private func readKeychain(account: String) throws -> String? {
        var query = keychainQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return value
    }

    private func deleteKeychain(account: String) {
        SecItemDelete(keychainQuery(account: account) as CFDictionary)
    }

    private func clearStoredAuth() {
        lock.lock()
        deleteKeychain(account: refreshAccount)
        deleteKeychain(account: rotationAccount)
        let calls = clearAccessTokenStateLocked(clearOrigin: true)
        lock.unlock()
        reject(calls: calls, message: "Mobile auth was cleared", code: "AUTH_REVOKED")
    }

    private func revokeAndReturnToLauncherIfCurrent(_ operation: RefreshOperation) -> [CAPPluginCall] {
        lock.lock()
        guard isCurrentRefreshLocked(operation) else {
            let calls = detachCallsLocked(operation)
            lock.unlock()
            return calls
        }
        deleteKeychain(account: refreshAccount)
        deleteKeychain(account: rotationAccount)
        let calls = clearAccessTokenStateLocked(clearOrigin: true)
        lock.unlock()
        returnToLocalLauncher()
        return calls
    }

    private func returnToLocalLauncher() {
        guard let localURL = bridge?.config.localURL else { return }
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.load(URLRequest(url: localURL))
        }
    }

    private static func parseISODate(_ value: String) -> Date? {
        let standard = ISO8601DateFormatter()
        if let parsed = standard.date(from: value) { return parsed }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value)
    }

    private func clearAccessTokenState(clearOrigin: Bool) -> [CAPPluginCall] {
        lock.lock()
        let calls = clearAccessTokenStateLocked(clearOrigin: clearOrigin)
        lock.unlock()
        return calls
    }

    private func clearAccessTokenStateLocked(clearOrigin: Bool) -> [CAPPluginCall] {
        let calls = invalidateRefreshLocked()
        accessToken = nil
        accessTokenExpiresAt = nil
        if clearOrigin { authorizedOrigin = nil }
        return calls
    }

    private func invalidateRefreshLocked() -> [CAPPluginCall] {
        authGeneration &+= 1
        guard let active = refreshOperation else { return [] }
        refreshOperation = nil
        let calls = active.calls
        active.calls.removeAll()
        return calls
    }

    private func isCurrentRefreshLocked(_ operation: RefreshOperation) -> Bool {
        refreshOperation === operation && MobileAuthPolicy.isCurrentRefresh(
            operationGeneration: operation.generation,
            currentGeneration: authGeneration,
            operationOrigin: operation.origin,
            authorizedOrigin: authorizedOrigin,
            currentURL: bridge?.webView?.url
        )
    }

    private func detachCallsLocked(_ operation: RefreshOperation) -> [CAPPluginCall] {
        if refreshOperation === operation { refreshOperation = nil }
        let calls = operation.calls
        operation.calls.removeAll()
        return calls
    }

    private func finish(operation: RefreshOperation, message: String, code: String, error: Error? = nil) {
        lock.lock()
        let calls = detachCallsLocked(operation)
        lock.unlock()
        reject(calls: calls, message: message, code: code, error: error)
    }

    private func reject(calls: [CAPPluginCall], message: String, code: String, error: Error? = nil) {
        for call in calls { call.reject(message, code, error) }
    }
}
