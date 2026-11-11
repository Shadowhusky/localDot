import AppKit
import UserNotifications

// Runs only when localDot needs to show a banner. Its bundle supplies the app name and mascot.
// Titles/bodies are plain arguments, never evaluated as AppleScript or shell code.
final class Banner: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    func finish(_ code: Int32) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(code) }
    }
    // Set before launch finishes, so a click that relaunched this helper reaches it.
    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = Array(CommandLine.arguments.dropFirst())
        // Relaunched by a click on a banner: its response arrives shortly, or there is none.
        if args.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) }
            return
        }
        if args == ["--inspect"] {
            center.getNotificationSettings { settings in
                print("bundle=\(Bundle.main.bundleIdentifier ?? "missing") icon=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") ?? "missing") authorization=\(settings.authorizationStatus.rawValue)")
                self.finish(0)
            }
            return
        }
        guard args.count == 2 || args.count == 3 else { finish(64); return }
        center.requestAuthorization(options: [.alert, .sound]) { allowed, error in
            guard allowed && error == nil else { self.finish(2); return }
            let content = UNMutableNotificationContent()
            content.title = args[0]
            content.body = args[1]
            if args.count == 3, let link = Banner.link(args[2]) {
                content.userInfo = ["link": link.absoluteString]
            }
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            self.center.add(request) { error in self.finish(error == nil ? 0 : 1) }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .list])
    }
    // A click opens localDot at the banner's task; only a web link is ever opened.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let text = response.notification.request.content.userInfo["link"] as? String,
           let link = Banner.link(text) {
            NSWorkspace.shared.open(link)
        }
        completion()
        finish(0)
    }
    static func link(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme == "http" || url.scheme == "https",
              url.host != nil else { return nil }
        return url
    }
}
let application = NSApplication.shared
let banner = Banner()
application.delegate = banner
application.setActivationPolicy(.accessory)
application.run()
