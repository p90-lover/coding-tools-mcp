export const electronBridgeContracts = Object.freeze({
  proxy: Object.freeze({
    snapshot: "proxy.snapshot",
    update: "proxy.update",
    test: "proxy.test",
  }),
  providers: Object.freeze({
    snapshot: "providers.snapshot",
    save: "providers.save",
    connect: "providers.connect",
    discoverModels: "providers.discoverModels",
  }),
  agents: Object.freeze({
    snapshot: "agents.snapshot",
    save: "agents.save",
    remove: "agents.remove",
  }),
  orchestrator: Object.freeze({
    snapshot: "orchestrator.snapshot",
    create: "orchestrator.create",
    saveWorkflow: "orchestrator.saveWorkflow",
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
  webTasks: Object.freeze({
    snapshot: "webTasks.snapshot",
    save: "webTasks.save",
    run: "webTasks.run",
  }),
  monitor: Object.freeze({
    snapshot: "monitor.snapshot",
    observe: "monitor.observe",
  }),
});

export type ElectronBridgeDomain = keyof typeof electronBridgeContracts;
