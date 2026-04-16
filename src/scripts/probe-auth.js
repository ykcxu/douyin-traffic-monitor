const { getAuthDiagnostics } = require("../services/auth-diagnostics-service");

async function main() {
  const data = await getAuthDiagnostics();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exit(1);
});
