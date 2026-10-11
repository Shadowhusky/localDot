import AppKit
import UserNotifications

// Runs only when localDot needs to show a banner. Its bundle supplies the app name and mascot.
// Titles/bodies are plain arguments, never evaluated as AppleScript or shell code.
final class Banner: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    func finish(_ code: Int32) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(code) }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--inspect"] {
            center.getNotificationSettings { settings in
                print("bundle=\(Bundle.main.bundleIdentifier ?? "missing") icon=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") ?? "missing") authorization=\(settings.authorizationStatus.rawValue)")
                self.finish(0)
            }
            return
        }
        guard args.count == 2 else { finish(64); return }
        center.requestAuthorization(options: [.alert, .sound]) { allowed, error in
            guard allowed && error == nil else { self.finish(2); return }
            let content = UNMutableNotificationContent()
            content.title = args[0]
            content.body = args[1]
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            self.center.add(request) { error in self.finish(error == nil ? 0 : 1) }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .list])
    }
}
let application = NSApplication.shared
let banner = Banner()
application.delegate = banner
application.setActivationPolicy(.accessory)
application.run()
