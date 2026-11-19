// HDM 远程面描述符（Typert invocation descriptors）。
// 纯数据模块：不 import node:*，客户端半可以把同样的字面量内联进去。
// 端点 id 形如 `dsh-hdm#hdmSettings/<method>`，命名空间 `hdmSettings` 与 serviceKey 一致。

const jsonCodec = (name) => ({
  mode: "strict",
  typeSymbol: `dsh-hdm#${name}`,
  create: () => ({ parse: (value) => value }),
});

const parseBoolean = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error("Expected a boolean");
  return value;
};

const OVERWRITE_CODEC = {
  mode: "strict",
  typeSymbol: "dsh-hdm#HdmOverwrite",
  create: () => ({ parse: parseBoolean }),
};

const RESULT = jsonCodec("HdmSettingsResult");

function method(name, parameter) {
  return {
    id: `dsh-hdm#hdmSettings/${name}`,
    service: "hdmSettings",
    namespace: "hdmSettings",
    method: name,
    invocation: { kind: "direct" },
    result: RESULT,
    parameters: parameter
      ? [{ name: parameter.wire, wire: parameter.wire, source: "json", codec: parameter.codec }]
      : [],
  };
}

/** 两个端点：生成 IAM_Blank.md、读取维护信息（模型/最近运行/今日预算）。 */
export const HDM_DESCRIPTORS = Object.freeze([
  method("generateIamBlank", { wire: "overwrite", codec: OVERWRITE_CODEC }),
  method("maintenanceInfo"),
]);

/** 客户端 `remote.$mount()` 的入参形态（与 dsh-ops 一致）。 */
export const HDM_REMOTE = Object.freeze({ package: "dsh-hdm", descriptors: HDM_DESCRIPTORS });
