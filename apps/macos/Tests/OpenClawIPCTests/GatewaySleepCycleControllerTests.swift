@testable import OpenClaw
import Testing

private struct PrepareFailure: Error {}

@Suite(.serialized)
@MainActor
struct GatewaySleepCycleControllerTests {
    @Test func `ready preparation resumes its suspension once and refreshes`() async {
        var preparedRequestIDs: [String] = []
        var resumedIDs: [String] = []
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            prepare: { requestID in
                preparedRequestIDs.append(requestID)
                return .ready(suspensionID: "suspension-1")
            },
            resume: { resumedIDs.append($0) },
            refresh: { refreshCount += 1 },
            log: { _ in }
        )

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)
        await controller.didWake(mode: .local)

        #expect(preparedRequestIDs == ["macos-sleep-test-run"])
        #expect(resumedIDs == ["suspension-1"])
        #expect(refreshCount == 2)
    }

    @Test func `busy preparation does not resume but still refreshes`() async {
        var resumeCount = 0
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            prepare: { _ in .busy },
            resume: { _ in resumeCount += 1 },
            refresh: { refreshCount += 1 },
            log: { _ in }
        )

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)

        #expect(resumeCount == 0)
        #expect(refreshCount == 1)
    }

    @Test func `failed preparation does not resume but still refreshes`() async {
        var resumeCount = 0
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            prepare: { _ in throw PrepareFailure() },
            resume: { _ in resumeCount += 1 },
            refresh: { refreshCount += 1 },
            log: { _ in }
        )

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)

        #expect(resumeCount == 0)
        #expect(refreshCount == 1)
    }

    @Test func `remote mode performs no sleep or wake work`() async {
        var prepareCount = 0
        var resumeCount = 0
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            prepare: { _ in
                prepareCount += 1
                return .ready(suspensionID: "unused")
            },
            resume: { _ in resumeCount += 1 },
            refresh: { refreshCount += 1 },
            log: { _ in }
        )

        await controller.willSleep(mode: .remote)
        await controller.didWake(mode: .remote)

        #expect(prepareCount == 0)
        #expect(resumeCount == 0)
        #expect(refreshCount == 0)
    }
}
