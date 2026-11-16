import AppKit
import UserNotifications

// Runs only when localDot needs to show a banner. Its bundle supplies the app name and mascot.
// Titles, bodies and addresses are plain arguments, never evaluated as AppleScript or shell code.
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
        guard (2...4).contains(args.count) else { finish(64); return }
        center.requestAuthorization(options: [.alert, .sound]) { allowed, error in
            guard allowed && error == nil else { self.finish(2); return }
            let content = UNMutableNotificationContent()
            content.title = args[0]
            content.body = args[1]
            if args.count >= 3, let link = Banner.link(args[2]) {
                // Every address localDot answers at, so a click finds its tab at whichever one.
                let origins = args.count == 4
                    ? args[3].split(separator: " ").compactMap { Banner.origin(String($0)) } : []
                content.userInfo = ["link": link.absoluteString, "origins": origins]
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
    // A click brings the localDot tab already open to the front, at the banner's task, whatever
    // address it is at; only when there is none does it open the link. Only a web link is opened.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let text = info["link"] as? String,
           let link = Banner.link(text) {
            let origins = ((info["origins"] as? [String]) ?? []).compactMap(Banner.origin)
            let task = link.fragment.flatMap(Banner.task) ?? ""
            if !OpenTab.bring(task: task, origins: origins + [Banner.origin(of: link)].compactMap { $0 }) {
                NSWorkspace.shared.open(link)
            }
        }
        completion()
        finish(0)
    }
    static func link(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme == "http" || url.scheme == "https",
              url.host != nil else { return nil }
        return url
    }
    // A bare web origin, as "https://host:port", or nothing.
    static func origin(_ text: String) -> String? {
        guard let url = URL(string: text), url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil else {
            return nil
        }
        return origin(of: url)
    }
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme, scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        let name = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(scheme)://\(name):\($0)" } ?? "\(scheme)://\(name)"
    }
    // The task a link's fragment names: "session=" and a task id.
    static func task(_ fragment: String) -> String? {
        let id = fragment.hasPrefix("session=") ? String(fragment.dropFirst(8)) : ""
        return id.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil ? id : nil
    }
}

// The browsers whose tabs AppleScript can read and switch, by bundle id. A browser that is not
// running is never started for this.
enum OpenTab {
    static let chromium = ["com.google.Chrome", "com.google.Chrome.beta", "com.brave.Browser",
                           "com.microsoft.edgemac", "com.vivaldi.Vivaldi"]
    static let safari = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"]

    // Finds a tab at one of the origins, shows the task in it (a fragment change, so the page stays)
    // and brings it to the front. The first time, macOS asks whether localDot may do this.
    static func bring(task: String, origins: [String]) -> Bool {
        guard !origins.isEmpty else { return false }
        let running = NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier }
        for id in chromium + safari where running.contains(id) {
            let tabs = chromium.contains(id)
                ? "set i to 0\n      repeat with t in tabs of w\n        set i to i + 1"
                : "repeat with t in tabs of w"
            let show = chromium.contains(id)
                ? "set active tab index of w to i" : "set current tab of w to t"
            let source = """
            on bring(task, origins)
              tell application id "\(id)"
                repeat with w in windows
                  \(tabs)
                    set u to URL of t
                    if u is not missing value then
                      repeat with o in origins
                        set o to contents of o
                        if u is o or u starts with (o & "/") then
                          set wanted to o & "/"
                          if task is not "" then set wanted to wanted & "#session=" & task
                          if u is not wanted then set URL of t to wanted
                          \(show)
                          set index of w to 1
                          activate
                          return true
                        end if
                      end repeat
                    end if
                  end repeat
                end repeat
              end tell
              return false
            end bring
            """
            guard let script = NSAppleScript(source: source) else { continue }
            let call = NSAppleEventDescriptor(
                eventClass: AEEventClass(0x6173_6372), // 'ascr'
                eventID: AEEventID(0x7073_6272), // 'psbr': call a handler by name
                targetDescriptor: nil,
                returnID: AEReturnID(kAutoGenerateReturnID),
                transactionID: AETransactionID(kAnyTransactionID))
            call.setDescriptor(NSAppleEventDescriptor(string: "bring"), forKeyword: AEKeyword(0x736E_616D)) // 'snam'
            let list = NSAppleEventDescriptor.list()
            list.insert(NSAppleEventDescriptor(string: task), at: 1)
            let addresses = NSAppleEventDescriptor.list()
            for (at, origin) in origins.enumerated() {
                addresses.insert(NSAppleEventDescriptor(string: origin), at: at + 1)
            }
            list.insert(addresses, at: 2)
            call.setParam(list, forKeyword: AEKeyword(keyDirectObject))
            var error: NSDictionary?
            if script.executeAppleEvent(call, error: &error).booleanValue { return true }
        }
        return false
    }
}
let application = NSApplication.shared
let banner = Banner()
application.delegate = banner
application.setActivationPolicy(.accessory)
application.run()
