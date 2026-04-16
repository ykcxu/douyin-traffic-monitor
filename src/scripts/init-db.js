const { bootstrapProject } = require("../services/bootstrap-service");

function main() {
  const { summary } = bootstrapProject();
  console.log("数据库初始化完成。");
  console.log(`已同步监控目标: ${summary.total}`);
}

main();
