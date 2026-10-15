import AppKit
import AVKit

/// Native presentation only. The preview controller owns readiness, identity and the delivery lease.
@MainActor
final class PreviewWindow: NSObject, PreviewPresenting, NSWindowDelegate {
    private var window: NSWindow?
    private var playerView: AVPlayerView?
    private var playerObservation: NSKeyValueObservation?
    private var compositionTask: Task<Void, Never>?
    private var message: NSTextField?
    private var retry: NSButton?
    private var onRetry: (@MainActor () -> Void)?
    private var onClose: (@MainActor () -> Void)?
    private var timelineBar: NSStackView?
    private var exportButton: NSButton?
    /// The strip above the video, holding revision history and Export; hidden while empty.
    private static let barHeight: CGFloat = 36
    private var timelineActions: [ObjectIdentifier: @MainActor () -> Void] = [:]
    private var exportAction: (@MainActor () -> Void)?

    /// While a take records, previews stay out of every capture: a display take leaves out this
    /// app's windows only if one was on screen when it began, and a preview may open after. At any
    /// other time people can screenshot and share them.
    static var takeInProgress = false {
        didSet { for preview in shown.allObjects { preview.applySharing() } }
    }
    private static let shown = NSHashTable<PreviewWindow>.weakObjects()
    private func applySharing() { window?.sharingType = Self.takeInProgress ? .none : .readOnly }

    /// Checks that intentionally exercise real windows keep them behind the person's work.
    private static let observed = !(ProcessInfo.processInfo.environment["YAP_FIXTURE_CONTROLS"] ?? "")
        .isEmpty

    func open(title: String, retry onRetry: @escaping @MainActor () -> Void,
        closed onClose: @escaping @MainActor () -> Void)
    {
        self.onRetry = onRetry
        self.onClose = onClose
        // Recordings are usually 16:9; a window of that shape shows one without letterboxing.
        // Yap's own captures leave out its windows by app, so people can still screenshot this one.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 450),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.title = title
        let container = NSView(frame: window.contentView!.bounds)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        window.contentView = container
        let view = AVPlayerView(frame: container.bounds)
        view.autoresizingMask = [.width, .height]
        view.controlsStyle = .floating
        view.showsSharingServiceButton = false
        view.allowsVideoFrameAnalysis = false
        container.addSubview(view)
        let bar = NSStackView(frame: NSRect(x: 0, y: container.bounds.height - Self.barHeight,
            width: container.bounds.width, height: Self.barHeight))
        bar.autoresizingMask = [.width, .minYMargin]
        bar.orientation = .horizontal
        bar.alignment = .centerY
        bar.spacing = 6
        bar.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        bar.isHidden = true
        container.addSubview(bar)
        timelineBar = bar
        let label = NSTextField(wrappingLabelWithString: "Preparing preview…")
        label.frame = NSRect(x: 24, y: 220, width: 752, height: 60)
        label.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        label.alignment = .center
        label.textColor = .white
        view.addSubview(label)
        let button = NSButton(title: "Retry Preview", target: self, action: #selector(retryPreview))
        button.frame = NSRect(x: 330, y: 180, width: 140, height: 32)
        button.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        button.isHidden = true
        view.addSubview(button)
        self.window = window
        Self.shown.add(self)
        applySharing()
        playerView = view
        message = label
        retry = button
        window.center()
        // An ordinary user preview comes forward; an explicit window check never takes focus.
        if Self.observed {
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func show(title: String, message: String, canRetry: Bool) {
        window?.title = title
        self.message?.stringValue = message
        self.message?.isHidden = false
        retry?.isHidden = !canRetry
    }

    func showTimeline(_ items: [PreviewTimelineItem], selected: String, select: @escaping @MainActor (String) -> Void) {
        guard let bar = timelineBar else { return }
        for view in bar.arrangedSubviews where view !== exportButton {
            bar.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        timelineActions.removeAll()
        for item in items {
            let button = NSButton(title: item.label, target: self, action: #selector(selectTimeline(_:)))
            button.bezelStyle = .texturedRounded
            button.controlSize = .small
            button.toolTip = item.operation
            button.identifier = .init("timeline.\(item.id)")
            button.state = item.id == selected ? .on : .off
            timelineActions[ObjectIdentifier(button)] = { select(item.id) }
            bar.insertArrangedSubview(button, at: bar.arrangedSubviews.count - (exportButton == nil ? 0 : 1))
        }
        layoutBar()
    }

    func showExport(_ action: @escaping @MainActor () -> Void) {
        exportAction = action
        guard let bar = timelineBar, exportButton == nil else { return }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        bar.addArrangedSubview(spacer)
        let button = NSButton(title: "Export", target: self, action: #selector(exportPreview(_:)))
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.identifier = .init("inspector.export")
        bar.addArrangedSubview(button)
        exportButton = button
        layoutBar()
    }

    /// Shows the strip only when it holds something, above the video rather than over it. The
    /// window grows by the strip's height so the video keeps its shape.
    private func layoutBar() {
        guard let bar = timelineBar, let view = playerView, let window,
            let container = window.contentView else { return }
        let showing = bar.arrangedSubviews.contains { $0 is NSButton }
        guard showing == bar.isHidden else { return }
        bar.isHidden = !showing
        var frame = window.frame
        let change = showing ? Self.barHeight : -Self.barHeight
        frame.size.height += change
        frame.origin.y -= change
        window.setFrame(frame, display: true)
        view.frame = NSRect(x: 0, y: 0, width: container.bounds.width,
            height: container.bounds.height - (showing ? Self.barHeight : 0))
        bar.frame = NSRect(x: 0, y: container.bounds.height - Self.barHeight,
            width: container.bounds.width, height: Self.barHeight)
    }

    func play(title: String, file: String, mediaType: String,
        failed: @escaping @MainActor (String) -> Void)
    {
        window?.title = title
        message?.isHidden = true
        retry?.isHidden = true
        // Cache names describe ownership, not containers; use the validated receipt's MIME type.
        let asset = AVURLAsset(url: URL(fileURLWithPath: file),
            options: [AVURLAssetOverrideMIMETypeKey: mediaType])
        let item = AVPlayerItem(asset: asset)
        playerObservation = item.observe(\.status, options: [.new]) { item, _ in
            guard item.status == .failed else { return }
            let reason = item.error?.localizedDescription ?? "Preview playback failed."
            Task { @MainActor in failed(reason) }
        }
        playerView?.player = AVPlayer(playerItem: item)
        playerView?.player?.play()
    }

    func playLocalFile(title: String, file: String, mediaType: String) {
        close()
        open(title: title, retry: {}, closed: {})
        play(title: title, file: file, mediaType: mediaType, failed: { _ in })
    }

    /// A captured take stores picture and microphone narration as separate canonical members.
    /// AVPlayer accepts an in-memory composition, so the library can preview both without
    /// manufacturing a derived file or changing the retained source.
    func playLocalRecording(title: String, video: String, narration: String) {
        close()
        open(title: title, retry: {}, closed: {})
        let picture = AVURLAsset(url: URL(fileURLWithPath: video),
            options: [AVURLAssetOverrideMIMETypeKey: "video/quicktime"])
        let voice = AVURLAsset(url: URL(fileURLWithPath: narration),
            options: [AVURLAssetOverrideMIMETypeKey: "video/quicktime"])
        let composition = AVMutableComposition()
        compositionTask = Task { @MainActor [weak self] in
          do {
            let pictureTracks = try await picture.loadTracks(withMediaType: .video)
            let voiceTracks = try await voice.loadTracks(withMediaType: .audio)
            guard let pictureTrack = pictureTracks.first, let voiceTrack = voiceTracks.first else {
                throw NSError(domain: "YapPreview", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Recording media has no playable tracks."])
            }
            guard let composedPicture = composition.addMutableTrack(withMediaType: .video,
                preferredTrackID: kCMPersistentTrackID_Invalid),
                let composedVoice = composition.addMutableTrack(withMediaType: .audio,
                    preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw NSError(domain: "YapPreview", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Could not create preview tracks."])
            }
            try composedPicture.insertTimeRange(pictureTrack.timeRange, of: pictureTrack, at: .zero)
            try composedVoice.insertTimeRange(voiceTrack.timeRange, of: voiceTrack, at: .zero)
            let item = AVPlayerItem(asset: composition)
            self?.playerObservation = item.observe(\.status, options: [.new]) { item, _ in
                guard item.status == .failed else { return }
            }
            self?.message?.isHidden = true
            self?.retry?.isHidden = true
            self?.playerView?.player = AVPlayer(playerItem: item)
            self?.playerView?.player?.play()
          } catch {
            guard !Task.isCancelled else { return }
            self?.show(title: title, message: error.localizedDescription, canRetry: false)
          }
        }
    }

    func close() {
        compositionTask?.cancel()
        compositionTask = nil
        playerObservation = nil
        playerView?.player?.pause()
        playerView?.player?.replaceCurrentItem(with: nil)
        playerView?.player = nil
        window?.delegate = nil
        window?.close()
        window = nil
        playerView = nil
        message = nil
        retry = nil
        onRetry = nil
        onClose = nil
        timelineBar = nil
        exportButton = nil
        timelineActions.removeAll()
        exportAction = nil
    }

    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === window else { return }
        onClose?()
    }

    @objc private func retryPreview() { onRetry?() }
    @objc private func selectTimeline(_ sender: NSButton) { timelineActions[ObjectIdentifier(sender)]?() }
    @objc private func exportPreview(_ sender: NSButton) { exportAction?() }
}
