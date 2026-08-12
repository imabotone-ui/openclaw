import AppKit
import Foundation
import Observation
import OpenClawProtocol
import OSLog

private let gatewayConnectivityLogger = Logger(
    subsystem: "ai.openclaw",
    category: "gateway.connectivity"
)

private struct GatewaySleepPrepareResponse: Decodable {
    let status: String
    let suspensionId: String?
}

@MainActor
@Observable
final class GatewayConnectivityCoordinator {
    static let shared = GatewayConnectivityCoordinator()

    private var endpointTask: Task<Void, Never>?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var lastResolvedURL: URL?
    private var lastRouteRevision: UInt64?
    private let sleepCycleController: GatewaySleepCycleController

    private(set) var endpointState: GatewayEndpointState?
    private(set) var resolvedURL: URL?
    private(set) var resolvedMode: AppState.ConnectionMode?
    private(set) var resolvedHostLabel: String?

    private init() {
        sleepCycleController = GatewaySleepCycleController(
            requestID: "macos-sleep-\(UUID().uuidString.lowercased())",
            prepare: { requestID in
                let data = try await GatewayConnection.shared.request(
                    method: "gateway.suspend.prepare",
                    params: ["requestId": AnyCodable(requestID)],
                    timeoutMs: 3000,
                    retryTransportFailures: false
                )
                let response = try JSONDecoder().decode(GatewaySleepPrepareResponse.self, from: data)
                guard response.status == "ready", let suspensionID = response.suspensionId else {
                    return .busy
                }
                return .ready(suspensionID: suspensionID)
            },
            resume: { suspensionID in
                _ = try await GatewayConnection.shared.request(
                    method: "gateway.suspend.resume",
                    params: ["suspensionId": AnyCodable(suspensionID)],
                    timeoutMs: 3000,
                    retryTransportFailures: false
                )
            },
            refresh: { await GatewayEndpointStore.shared.refresh() },
            log: { message in gatewayConnectivityLogger.error("\(message, privacy: .public)") }
        )
        start()
    }

    func start() {
        guard endpointTask == nil else { return }
        registerSleepWakeObservers()
        endpointTask = Task { [weak self] in
            guard let self else { return }
            let stream = await GatewayEndpointStore.shared.subscribe()
            for await state in stream {
                await MainActor.run { self.handleEndpointState(state) }
            }
        }
    }

    private func registerSleepWakeObservers() {
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.sleepCycleController.willSleep(mode: self.resolvedMode)
            }
        })
        workspaceObservers.append(center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.sleepCycleController.didWake(mode: self.resolvedMode)
            }
        })
    }

    var localEndpointHostLabel: String? {
        guard resolvedMode == .local, let url = resolvedURL else { return nil }
        return Self.hostLabel(for: url)
    }

    private func handleEndpointState(_ state: GatewayEndpointState) {
        endpointState = state
        switch state {
        case let .ready(mode, url, _, _, routeRevision):
            resolvedMode = mode
            resolvedURL = url
            resolvedHostLabel = Self.hostLabel(for: url)
            let routeChanged = lastResolvedURL?.absoluteString != url.absoluteString ||
                lastRouteRevision != routeRevision
            if routeChanged {
                lastResolvedURL = url
                lastRouteRevision = routeRevision
                Task { await ControlChannel.shared.refreshEndpoint(reason: "endpoint changed") }
            }
        case let .connecting(mode, _):
            resolvedMode = mode
        case let .unavailable(mode, _):
            resolvedMode = mode
        }
    }

    private static func hostLabel(for url: URL) -> String {
        let host = url.host ?? url.absoluteString
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }
}
