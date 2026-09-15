import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test("an already-personalized connector menu has no unconditional pre-mention delay", async () => {
  let menuVisible = false;
  let selected = false;
  let mentionTriggers = 0;
  const exactLabel = { exactLabel: true };
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
    },
  };
  const appResult = {
    waitFor: async () => {
      if (!menuVisible) {
        const error = new Error("connector menu was not visible");
        error.name = "TimeoutError";
        throw error;
      }
    },
    count: async () => 1,
    getAttribute: async (name: string) => {
      expect(name).toBe("data-highlighted");
      return menuVisible ? "" : null;
    },
  };
  const menuRows = {
    filter: (options: { has?: unknown; visible?: boolean }) => {
      if (options.has !== undefined) {
        expect(options.has).toBe(exactLabel);
        return appResult;
      }
      return { count: async () => menuVisible ? 1 : 0 };
    },
  };
  const composer = {
    fill: async (value: string) => {
      expect(value).toBe("");
      menuVisible = false;
    },
    focus: async () => {},
    pressSequentially: async (value: string) => {
      expect(value).toBe("@codex");
      mentionTriggers += 1;
      menuVisible = true;
    },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      expect(menuVisible).toBeTrue();
      selected = true;
      menuVisible = false;
    },
  };
  const selectedComposer = { selected: true };
  const personalizedRole = (
    _role: string,
    options: { name: string | RegExp },
  ) => ({
    filter: ({ visible }: { visible: boolean }) => {
      expect(visible).toBeTrue();
      return {
        count: async () => {
          const name = options.name;
          return typeof name === "string"
            ? Number(name === "Personalized")
            : Number(name.test("Personalized"));
        },
      };
    },
  });
  const page = {
    getByRole: personalizedRole,
    getByText: (text: string, options: { exact: boolean }) => {
      expect(text).toBe("Codex Native2");
      expect(options).toEqual({ exact: true });
      return exactLabel;
    },
    locator: (selector: string) => {
      expect(selector).toBe('.__menu-item[tabindex="0"]');
      return menuRows;
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  const startedAt = performance.now();
  const resolved = await selectConnector.call({
    config: { appName: "Codex Native2" },
    activeComposer: async () => selected ? selectedComposer : composer,
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
  }, page);
  const elapsedMs = performance.now() - startedAt;

  expect(resolved).toBe(selectedComposer);
  expect(mentionTriggers).toBe(1);
  expect(selected).toBeTrue();
  // The fake page performs no I/O. Crossing this bound means selection inserted a fixed wait.
  expect(elapsedMs).toBeLessThan(200);
});
