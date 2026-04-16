const path = require("path");
const { bootstrapProject } = require("./services/bootstrap-service");
const { buildTaskRegistry } = require("./tasks/task-registry");

function main() {
  const { filePath, summary } = bootstrapProject();
  const tasks = buildTaskRegistry();

  console.log("抖音流量监控项目已加载监控目标。");
  console.log(`数据来源: ${path.basename(filePath)}`);
  console.log(`监控账号总数: ${summary.total}`);
  console.log(`包含直播间链接: ${summary.withLiveRoom}`);
  console.log(`包含主页链接: ${summary.withProfile}`);
  console.log("分类统计:", summary.byCategory);
  console.log("部门统计:", summary.byDepartment);
  console.log("任务注册表:", tasks);
}

main();
