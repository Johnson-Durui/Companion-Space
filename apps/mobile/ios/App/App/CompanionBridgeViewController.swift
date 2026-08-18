import Capacitor

final class CompanionBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginType(CompanionAuthPlugin.self)
    }
}
