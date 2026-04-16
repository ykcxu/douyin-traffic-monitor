const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDepartmentComparisonView, buildInternalVsCompetitorView } = require("../src/services/comparison-service");

function createMockDb(departmentRows, categoryRows) {
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes("GROUP BY department")) {
            return departmentRows;
          }
          if (sql.includes("GROUP BY category")) {
            return categoryRows;
          }
          return [];
        }
      };
    }
  };
}

test("department comparison view merges baseline and snapshot summary", () => {
  const db = createMockDb(
    [
      {
        department: "小数",
        sampledRooms: 2,
        liveRooms: 1,
        avgOnlineCount: 12.345,
        peakOnlineCount: 88,
        avgLikeCount: 9.9
      }
    ],
    []
  );

  const baseline = [
    {
      department: "小数",
      totalAccounts: 8,
      liveEnabledAccounts: 6,
      internalAccounts: 8,
      competitorAccounts: 0
    },
    {
      department: "小语",
      totalAccounts: 6,
      liveEnabledAccounts: 3,
      internalAccounts: 6,
      competitorAccounts: 0
    }
  ];

  const rows = buildDepartmentComparisonView(db, baseline);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].department, "小数");
  assert.equal(rows[0].sampledRooms, 2);
  assert.equal(rows[0].liveRooms, 1);
  assert.equal(rows[0].avgOnlineCount, 12.35);
  assert.equal(rows[1].department, "小语");
  assert.equal(rows[1].sampledRooms, 0);
});

test("internal vs competitor view exposes baseline and snapshot sections", () => {
  const db = createMockDb(
    [],
    [
      {
        category: "内部",
        sampledRooms: 4,
        liveRooms: 2,
        avgOnlineCount: 10.2,
        peakOnlineCount: 80,
        avgLikeCount: 20.6
      },
      {
        category: "竞品",
        sampledRooms: 3,
        liveRooms: 1,
        avgOnlineCount: 15.6,
        peakOnlineCount: 99,
        avgLikeCount: 50.4
      }
    ]
  );

  const baseline = {
    internalAccounts: 21,
    competitorAccounts: 5,
    internalLiveRooms: 12,
    competitorLiveRooms: 4
  };

  const payload = buildInternalVsCompetitorView(db, baseline);
  assert.equal(payload.targetBaseline.internalAccounts, 21);
  assert.equal(payload.snapshotView.internal.category, "内部");
  assert.equal(payload.snapshotView.competitor.category, "竞品");
  assert.equal(payload.snapshotView.competitor.peakOnlineCount, 99);
});
