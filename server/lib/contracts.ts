/**
 * contracts 桥接 — server 消费 @yunzone-infer/contracts 生成类型的唯一入口
 *
 * 类型来自 contracts codegen（D15 单一事实源，勿手写副本）；
 * 全部为 type-only import（运行时零依赖，codegen 前置由 package.json pre hooks 保证）。
 */
export type {
  ErrorCode,
  ErrorEnvelope,
  EndpointCapability,
  ModelQueueEntry,
  RegisterRequest,
  RegisterResponse,
  HeartbeatResponse,
  CompletionReport,
  CompletionReportResponse,
  TensorMeta,
  StageMetrics,
  TaskDispatch,
  TaskRevoke,
  WorkflowStatus,
  WorkflowLifecycleStatus,
  InputUploadUrlResponse,
  NodeOutputUrlResponse,
  StartWorkflowRequest,
  BindingPlan,
  RemoteNodeBinding,
  WorkflowStatusSnapshot,
  GraphExecutionStatus,
  NodeExecutionState,
  NodeState,
  NodeCompletionNotice,
} from "@yunzone-infer/contracts";
