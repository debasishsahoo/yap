import Foundation

/// A message the Yap team can show to specific versions, read from a static file on the website,
/// for when something has gone wrong and people need to be told what to do. Nothing depends on it:
/// any failure to fetch or read it leaves the app exactly as it was.
enum AdminNotice {
    static let feed = URL(string: "https://justyap.io/notices.json")!

    /// The first notice whose `versions` pattern matches `version`, or nil. A notice with an
    /// invalid pattern or an empty message is skipped; anything else unreadable means no notice.
    static func message(from data: Data, version: String) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let notices = root["notices"] as? [[String: Any]]
        else { return nil }
        for notice in notices {
            guard let pattern = notice["versions"] as? String,
                let message = notice["message"] as? String, !message.isEmpty,
                let regex = try? NSRegularExpression(pattern: pattern)
            else { continue }
            let whole = NSRange(version.startIndex..., in: version)
            if regex.firstMatch(in: version, range: whole) != nil { return message }
        }
        return nil
    }
}
