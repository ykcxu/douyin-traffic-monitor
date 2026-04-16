const { bootstrapProject } = require("../services/bootstrap-service");
const { sampleLiveTargets } = require("../services/live-sample-service");
const { listRecentRoomSnapshots } = require("../db/repositories/snapshot-repository");

async function main() {
  const { db, targets } = bootstrapProject();
  const results = await sampleLiveTargets(db, targets, { limit: 3 });
  const snapshots = listRecentRoomSnapshots(db, 3);

  console.log("直播间采样脚本执行完成。");
  console.log(`尝试采样数量: ${results.length}`);
  console.log(`成功数量: ${results.filter((item) => item.status === "ok").length}`);
  console.log(`失败数量: ${results.filter((item) => item.status === "error").length}`);
  console.log("最近采样结果:", snapshots);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
