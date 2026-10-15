import Foundation

/// A message the Yap team can show to specific versions, read from a static file on the website,
/// for when something has gone wrong and people need to be told what to do. Nothing depends on it:
/// any failure to fetch or read it leaves the app exactly as it was.
enum AdminNotice {
    static let feed = URL(string: "https://justyap.io/notices.json")!
    /// A feed is a short list; anything larger is not one.
    static let maxFeedBytes = 64 * 1024
    /// Long enough for instructions, short enough to lay out cheaply on every panel update.
    static let maxMessageCharacters = 500

    enum Lookup: Equatable {
        /// Not a notice feed: keep whatever is showing.
        case unreadable
        /// A feed with nothing for this version: show nothing.
        case none
        case message(String)
    }

    /// The first notice whose `versions` pattern matches `version`. A notice with an invalid
    /// pattern or a blank message is skipped; data that is not a feed is `unreadable`.
    static func lookup(in data: Data, version: String) -> Lookup {
        guard data.count <= maxFeedBytes,
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let notices = root["notices"] as? [Any]
        else { return .unreadable }
        for case let notice as [String: Any] in notices {
            guard let pattern = notice["versions"] as? String,
                let raw = notice["message"] as? String,
                case let message = raw.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty,
                let regex = try? NSRegularExpression(pattern: pattern)
            else { continue }
            let whole = NSRange(version.startIndex..., in: version)
            if regex.firstMatch(in: version, range: whole) != nil {
                return .message(String(message.prefix(maxMessageCharacters)))
            }
        }
        return .none
    }
}
