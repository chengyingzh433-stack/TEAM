import {
  FLIGHT_SECONDS,
  flightEase,
  presentArrivalTime,
} from "../../src/features/conversation/lancer-process/process-math";
import { expect, test } from "@playwright/test";
import { buildLiveProcessData } from "../../src/features/conversation/lancer-process/live-model";
import { LiveEmissionClock } from "../../src/features/conversation/lancer-process/live-emissions";
import { modelFamily } from "../../src/ui/model-families";
import {
  flightControls,
  processCurveRoutes,
} from "../../src/features/conversation/lancer-process/process-curve-routes";
import {
  buildDefaultLanes,
  type TrajectoryNode,
} from "../../src/features/conversation/session-trajectory/trajectory-model";

test("actual model identity wins over its transport gateway", () => {
  expect(modelFamily("openai-compatible", "claude-sonnet-4-5")?.id).toBe("claude");
  expect(modelFamily("example-gateway", "opaque-id", "Claude Opus")?.id).toBe("claude");
  expect(modelFamily("anthropic-gateway", "gpt-6.1-sol")?.id).toBe("openai");
  expect(modelFamily("example-gateway", "deepseek-v4-pro")?.id).toBe("deepseek");
  expect(modelFamily("example-gateway", "unknown")).toBeUndefined();
});

for (const [provider, family] of [
  ["openai-codex", "openai"],
  ["anthropic", "claude"],
  ["xai", "grok"],
  ["unknown", undefined],
] as const) {
  test(`live ${provider} routes its projected event from the real model identity`, () => {
    const lanes = buildDefaultLanes({
      workspaceId: "workspace",
      sessionId: "session",
      sessionTitle: "lancer-zone:lancer|Live",
    });
    const lane = lanes[0]!;
    const node: TrajectoryNode = {
      id: "message",
      parentId: null,
      kind: "message",
      title: "Real reply",
      timestamp: "",
      depth: 0,
      scrollTargetId: "message",
      laneId: lane.id,
      isActivePath: true,
      state: "neutral",
    };
    const input = {
      threads: [],
      selectedSessionId: "session",
      title: lane.label,
      provider,
      modelId: "real-model",
      processBlocks: [],
      trajectory: {
        lanes,
        nodes: [node],
        laneNodes: new Map([[lane.id, [node]]]),
        handoffs: [],
        metaChips: [],
        loading: false,
        reload: () => {},
        multiLane: false,
      },
    } satisfies Parameters<typeof buildLiveProcessData>[0];
    const { data } = buildLiveProcessData(input);
    const archived = buildLiveProcessData({
      ...input,
      archivedSessions: [
        { id: "workspace:session", workspaceId: "workspace", sessionId: "session", title: "Live" },
      ],
    });
    expect(archived.data.lanes).toHaveLength(0);
    expect(archived.data.events).toHaveLength(0);
    const event = data.events[0]!;
    expect(event.actor).toBe("selected-model");
    const clock = new LiveEmissionClock();
    clock.observe([], 0);
    clock.observe(data.events, 100);
    const routes = processCurveRoutes(
      data,
      {
        time: 26.5,
        flightTimes: clock.sample(data.events, 700),
        lane: "l",
        focus: "",
        open: new Set(),
        highlighted: null,
      },
      true,
      (key) =>
        key === `tree:${event.id}`
          ? { x: 900, y: 400 }
          : key === (family ? `family:${family}` : `chip:${event.lane}:${event.actor}`)
            ? { x: 400, y: 80 }
            : null,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]!.source).toBe(family ? `family:${family}` : `chip:${lane.id}:selected-model`);
    expect(routes[0]!.progress).toBeCloseTo(0.5);
  });
}

test("flight seeds vary arc direction and shape without changing during flight", () => {
  const a = { x: 300, y: 200 };
  const b = { x: 900, y: 200 };
  const arcs = [0.1, 0.35, 0.6, 0.85].map((seed) => flightControls(a, b, seed));
  expect(new Set(arcs.map((arc) => JSON.stringify(arc))).size).toBe(4);
  expect(arcs[0]!.every((point) => point.y < a.y)).toBe(true);
  expect(arcs[1]!.every((point) => point.y > a.y)).toBe(true);
  expect(arcs[2]![0].y).toBeLessThan(a.y);
  expect(arcs[2]![1].y).toBeGreaterThan(a.y);
  expect(flightControls(a, b, 0.6)).toEqual(arcs[2]);
  expect(flightControls({ x: 10, y: 5 }, b, 0.1).every((point) => point.y >= 8)).toBe(true);
});

test("arrival keeps the eased head on the anchor for the frames that can sample it", () => {
  const eventTime = 12;
  const noticedLate = presentArrivalTime(eventTime, eventTime + 0.4, 5, undefined);
  expect(noticedLate.shownFrame).toBe(5);
  expect(noticedLate.time).toBeCloseTo(eventTime - 1e-4);
  const progress = 1 - (eventTime - noticedLate.time) / FLIGHT_SECONDS;
  expect(flightEase(progress)).toBeGreaterThanOrEqual(0.999);
  expect(
    presentArrivalTime(eventTime, eventTime + 0.5, 6, noticedLate.shownFrame).time,
  ).toBeCloseTo(eventTime - 1e-4);
  expect(presentArrivalTime(eventTime, eventTime + 0.5, 7, noticedLate.shownFrame).time).toBe(
    eventTime + 0.5,
  );
  expect(presentArrivalTime(eventTime, eventTime - 0.2, 8, noticedLate.shownFrame)).toEqual({
    time: eventTime - 0.2,
    shownFrame: undefined,
  });
});

test("flight accelerates in the middle and slows symmetrically at both ends", () => {
  expect(flightEase(0)).toBe(0);
  expect(flightEase(1)).toBe(1);
  expect(flightEase(0.5)).toBe(0.5);
  expect(flightEase(0.1)).toBeLessThan(0.1);
  expect(1 - flightEase(0.9)).toBeCloseTo(flightEase(0.1));
  expect(flightEase(0.6) - flightEase(0.5)).toBeGreaterThan(flightEase(0.1));
});
