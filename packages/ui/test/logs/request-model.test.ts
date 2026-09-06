import { describe, expect, it } from "vitest";
import { inspectRequest, requestFieldLabel, requestFieldText } from "../../src/components/logs/request-model.js";

describe("captured request inspection", () => {
  it("separates Responses instructions, tools and unknown parameters without modifying the payload", () => {
    const payload = { model: "test-model", instructions: "Be precise", input: [{role:"user", content:[{type:"input_text",text:"Hello"}]}], tools:[{type:"function",name:"read",parameters:{type:"object"}}], reasoning:{effort:"high"}, future_field:{enabled:true} };
    const before = JSON.stringify(payload);
    const view = inspectRequest(payload);
    expect(view.model).toBe("test-model");
    expect(view.instructions[0]?.value).toBe("Be precise");
    expect(requestFieldText(view.conversation[0]?.value)).toBe("Hello");
    expect(requestFieldLabel(view.tools[0]!)).toBe("read");
    expect(view.parameters.map(field=>field.path)).toEqual(["model","reasoning","future_field"]);
    expect(JSON.stringify(payload)).toBe(before);
  });
  it("keeps Chat Completions system/developer messages and multimodal content in full", () => {
    const image = {type:"image_url",image_url:{url:"data:image/png;base64,example"}};
    const view = inspectRequest({messages:[{role:"system",content:"System"},{role:"developer",content:"Developer"},{role:"user",content:[{type:"text",text:"See this"},image]}],tools:[{type:"function",function:{name:"bash",parameters:{}}}]});
    expect(view.instructions).toHaveLength(2);
    expect(view.conversation[0]?.value).toMatchObject({content:[{text:"See this"},image]});
    expect(requestFieldLabel(view.tools[0]!)).toBe("bash");
  });
  it("understands Gemini config and Anthropic system blocks without losing custom fields", () => {
    const gemini=inspectRequest({contents:[{role:"user",parts:[{text:"Hello"}]}],config:{systemInstruction:{parts:[{text:"Be kind"}]},tools:[{functionDeclarations:[{name:"read"}]}],temperature:0}});
    expect(requestFieldText(gemini.instructions[0]?.value)).toBe("Be kind");
    expect(gemini.tools[0]?.path).toBe("config.tools[0]");
    expect(gemini.parameters[0]?.value).toBe(0);
    const anthropic=inspectRequest({system:[{type:"text",text:"Rules",cache_control:{type:"ephemeral"}}],messages:[],max_tokens:1024});
    expect(anthropic.instructions[0]?.value).toMatchObject([{cache_control:{type:"ephemeral"}}]);
    expect(anthropic.parameters[0]?.path).toBe("max_tokens");
  });
  it.each([null,"unparsed truncated body",42,[1,2]])("keeps non-object captures available as JSON: %j", payload => {
    expect(inspectRequest(payload).parameters).toEqual([{path:"$",value:payload}]);
  });
});
