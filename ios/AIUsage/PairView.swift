//
//  PairView.swift
//  AIUsage — pair with the desktop: scan the QR code (AVFoundation) or paste the pairing string.
//
//  The camera path degrades gracefully: no camera (Simulator), permission not yet asked, or denied.
//

import SwiftUI
import AVFoundation
import UIKit

@MainActor
struct PairView: View {
    @EnvironmentObject private var store: UsageStore
    @State private var pasted: String = ""
    @State private var errorText: String?
    @State private var cameraStatus: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var scannerPaused: Bool = false

    private var cameraAvailable: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return AVCaptureDevice.default(for: .video) != nil
        #endif
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    intro
                    scannerSection
                    pasteSection
                    privacyNote
                }
                .padding(16)
            }
            .background(Theme.screenBackground.ignoresSafeArea())
            .navigationTitle("Pair with desktop")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    // MARK: Sections

    private var intro: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Mirror your Claude and Codex limits")
                .font(.title3.weight(.semibold))
            Text("On the desktop widget open Settings ▸ Phone, turn on “Sync to phone”, set a relay URL and tap “Show pairing code”. Then scan it here or paste the string.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var scannerSection: some View {
        if !cameraAvailable {
            InfoBox(icon: "camera.fill",
                    text: "No camera is available here (Simulator or restricted device) — paste the pairing string below.")
        } else {
            switch cameraStatus {
            case .authorized:
                ZStack(alignment: .bottom) {
                    QRScannerView(onCode: handleScanned)
                        .frame(height: 260)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Text(scannerPaused ? "Not a valid pairing code — try again" : "Point the camera at the QR code")
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.bottom, 10)
                }
            case .notDetermined:
                Button {
                    requestCamera()
                } label: {
                    Label("Allow camera access to scan the QR code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            case .denied, .restricted:
                VStack(alignment: .leading, spacing: 8) {
                    InfoBox(icon: "camera.badge.ellipsis",
                            text: "Camera access is off for AI Usage. Allow it in Settings to scan, or paste the pairing string below.")
                    Button("Open iOS Settings") {
                        openSystemSettings()
                    }
                    .buttonStyle(.bordered)
                }
            @unknown default:
                InfoBox(icon: "camera.fill", text: "Camera state unknown — paste the pairing string below.")
            }
        }
    }

    private var pasteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Or paste the pairing string")
                .font(.subheadline.weight(.semibold))
            TextField("aiusage://pair?v=1&r=…&k=…", text: $pasted, axis: .vertical)
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            HStack {
                Button {
                    if let s = UIPasteboard.general.string {
                        pasted = s
                    }
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.bordered)
                Spacer()
                Button {
                    attemptPair(pasted, fromScanner: false)
                } label: {
                    Text("Pair")
                        .frame(minWidth: 80)
                }
                .buttonStyle(.borderedProminent)
                .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let e = errorText {
                Label(e, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.dangerText)
            }
            if let e = store.pairingLoadError {
                Label(e, systemImage: "key.slash")
                    .font(.footnote)
                    .foregroundStyle(Theme.dangerText)
            }
        }
    }

    private var privacyNote: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("The phone never holds your Claude or Codex credentials.", systemImage: "lock.shield")
                .font(.footnote.weight(.medium))
            Text("The desktop encrypts a small usage snapshot with a key that only travels inside this pairing code and uploads it to a relay you choose. This app downloads and decrypts it — the relay only ever sees ciphertext.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Theme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: Actions

    private func handleScanned(_ code: String) {
        if scannerPaused { return }
        attemptPair(code, fromScanner: true)
    }

    private func attemptPair(_ text: String, fromScanner: Bool) {
        do {
            try store.pair(from: text)
            errorText = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            Task { await store.refresh() }
        } catch {
            errorText = error.localizedDescription
            if fromScanner {
                scannerPaused = true
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    scannerPaused = false
                }
            }
        }
    }

    private func requestCamera() {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                cameraStatus = granted ? .authorized : .denied
            }
        }
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}

struct InfoBox: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - QR scanner (AVFoundation)

@MainActor
struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.onCode = onCode
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {
        uiViewController.onCode = onCode
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.aidanfl.aiusage.scanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var configured = false
    private var lastCode: String?
    private var lastCodeAt: Date = Date.distantPast
    private let messageLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black
        messageLabel.textColor = UIColor.white
        messageLabel.font = UIFont.systemFont(ofSize: 13)
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0
        messageLabel.isHidden = true
        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(messageLabel)
        NSLayoutConstraint.activate([
            messageLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            messageLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            messageLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
            messageLabel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),
        ])
        configureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startRunning()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopRunning()
    }

    private func showMessage(_ text: String) {
        messageLabel.text = text
        messageLabel.isHidden = false
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            showMessage("No camera available")
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            guard session.canAddInput(input) else {
                session.commitConfiguration()
                showMessage("Cannot use the camera")
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                showMessage("Cannot read QR codes on this device")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            if output.availableMetadataObjectTypes.contains(.qr) {
                output.metadataObjectTypes = [.qr]
            }
            session.commitConfiguration()

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.insertSublayer(layer, at: 0)
            previewLayer = layer
            configured = true
        } catch {
            showMessage("Camera error: \(error.localizedDescription)")
        }
    }

    private func startRunning() {
        guard configured else { return }
        let s = session
        sessionQueue.async {
            if !s.isRunning { s.startRunning() }
        }
    }

    private func stopRunning() {
        let s = session
        sessionQueue.async {
            if s.isRunning { s.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        for object in metadataObjects {
            guard let code = object as? AVMetadataMachineReadableCodeObject,
                  code.type == .qr,
                  let value = code.stringValue, !value.isEmpty else { continue }
            let now = Date()
            if value == lastCode && now.timeIntervalSince(lastCodeAt) < 2.0 { continue }
            lastCode = value
            lastCodeAt = now
            onCode?(value)
            break
        }
    }
}
