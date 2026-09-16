export const electronBridgeContracts = Object.freeze({
  proxy: Object.freeze({
    snapshot: "proxy.snapshot",
    update: "proxy.update",
    test: "proxy.test",
  }),
  orchestrator: Object.freeze({
    snapshot: "orchestrator.snapshot",
    create: "orchestrator.create",
    control: "orchestrator.control",
  }),
  paseo: Object.freeze({
    snapshot: "paseo.snapshot",
    createMission: "paseo.createMission",
    controlMission: "paseo.controlMission",
  }),
  anneal: Object.freeze({
    snapshot: "anneal.snapshot",
    createTask: "anneal.createTask",
    dispatch: "anneal.dispatch",
  }),
});

export type ElectronBridgeDomain = keyof typeof electronBridgeContracts;
