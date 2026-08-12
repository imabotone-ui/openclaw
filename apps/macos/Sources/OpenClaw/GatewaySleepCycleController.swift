import Foundation

enum GatewaySleepPrepareResult: Equatable {
    case ready(suspensionID: String)
    case busy
}

@MainActor
final class GatewaySleepCycleController {
    typealias Prepare = (String) async throws -> GatewaySleepPrepareResult
    typealias Resume = (String) async throws -> Void
    typealias Refresh = () async -> Void

    private let requestID: String
    private let prepare: Prepare
    private let resume: Resume
    private let refresh: Refresh
    private let log: (String) -> Void
    private var suspensionID: String?
    private var cycleGeneration: UInt64 = 0

    init(
        requestID: String,
        prepare: @escaping Prepare,
        resume: @escaping Resume,
        refresh: @escaping Refresh,
        log: @escaping (String) -> Void
    ) {
        self.requestID = requestID
        self.prepare = prepare
        self.resume = resume
        self.refresh = refresh
        self.log = log
    }

    func willSleep(mode: AppState.ConnectionMode?) async {
        guard mode == .local else { return }
        cycleGeneration &+= 1
        let generation = cycleGeneration
        do {
            switch try await prepare(requestID) {
            case let .ready(suspensionID):
                guard generation == cycleGeneration else { return }
                self.suspensionID = suspensionID
            case .busy:
                log("gateway sleep preparation skipped because the gateway is busy")
            }
        } catch {
            log("gateway sleep preparation failed: \(error.localizedDescription)")
        }
    }

    func didWake(mode: AppState.ConnectionMode?) async {
        guard mode == .local else { return }
        // Invalidate a prepare response that arrives after the wake notification;
        // its short-lived lease must expire instead of surviving into a later cycle.
        cycleGeneration &+= 1
        if let suspensionID = suspensionID {
            self.suspensionID = nil
            do {
                try await resume(suspensionID)
            } catch {
                log("gateway wake resume failed: \(error.localizedDescription)")
            }
        }
        await refresh()
    }
}
