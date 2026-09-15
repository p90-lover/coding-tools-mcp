import { expect, test } from "bun:test";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/browser-worker";

test("personalized and unpersonalized state reads start concurrently", async () => {
  let personalizedStarted = false;
  let unpersonalizedStarted = false;
  let fallbackUsed = false;
  let releasePersonalized!: () => void;
  const personalizedGate = new Promise<void>(resolve => {
    releasePersonalized = resolve;
  });
  const fallback = setTimeout(() => {
    fallbackUsed = true;
    releasePersonalized();
  }, 100);

  const page = {
    getByRole: (
      role: string,
      options: { name: string | RegExp },
    ) => {
      expect(role).toBe("button");
      const name = options.name;
      const personalized = typeof name === "string"
        ? name === "Personalized"
        : name.test("Personalized");
      return {
        filter: ({ visible }: { visible: boolean }) => {
          expect(visible).toBeTrue();
          return {
            count: async () => {
              if (personalized) {
                personalizedStarted = true;
                await personalizedGate;
                return 1;
              }
              unpersonalizedStarted = true;
              releasePersonalized();
              return 0;
            },
          };
        },
      };
    },
  };

  try {
    await expect(ensureChatGptPersonalizedConnectorAccess(page as never))
      .resolves.toBe("already-personalized");
  } finally {
    clearTimeout(fallback);
  }

  expect(personalizedStarted).toBeTrue();
  expect(unpersonalizedStarted).toBeTrue();
  // Serial reads need the fallback to release the first count; parallel reads do not.
  expect(fallbackUsed).toBeFalse();
});
