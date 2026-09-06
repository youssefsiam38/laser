import { expect, it } from "vitest";
import { accountUsageRefreshError } from "../../src/runtime/account-usage-error.js";
it("explains a stale service without asking users to reset valid credentials",()=>{
  const error=accountUsageRefreshError(new Error("unknown method pi/account-usage/refresh"));
  expect(error.message).toContain("older version");
  expect(error.message).toContain("Finish active work");
  expect(error.message).toContain("Reconnecting your OpenAI account is not needed");
  const other=new Error("Network unavailable");
  expect(accountUsageRefreshError(other)).toBe(other);
});
