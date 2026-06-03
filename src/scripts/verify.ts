import "dotenv/config";
import axios from "axios";

const api_url =
  process.env.API_URL || `http://localhost:${process.env.PORT || 3000}/api`;

const generate_uuid = (): string => {
  return Math.random().toString(36).substring(2, 15);
};

async function run_chaos_test() {
  console.log("🚀 Starting Chaos Test...");

  try {
    const sys_acc = "system_central";
    const user_a = "customer_yassa";
    const user_b = "customer_khairy";

    await axios.post(
      `${api_url}/accounts`,
      { account_id: sys_acc, account_type: "system" },
      { headers: { "idempotency-key": generate_uuid() } },
    );
    await axios.post(
      `${api_url}/accounts`,
      { account_id: user_a, account_type: "customer" },
      { headers: { "idempotency-key": generate_uuid() } },
    );
    await axios.post(
      `${api_url}/accounts`,
      { account_id: user_b, account_type: "customer" },
      { headers: { "idempotency-key": generate_uuid() } },
    );

    await axios.post(
      `${api_url}/transfers`,
      { from_account_id: sys_acc, to_account_id: user_a, amount: 500000 },
      { headers: { "idempotency-key": generate_uuid() } },
    );

    console.log("Accounts initialized.");

    const promises: Promise<any>[] = [];
    const shared_idempotency_key = `race-key-${generate_uuid()}`;

    promises.push(
      axios
        .post(
          `${api_url}/transfers`,
          { from_account_id: user_a, to_account_id: user_b, amount: 1000 },
          { headers: { "idempotency-key": shared_idempotency_key } },
        )
        .catch((e) => e.response),
      axios
        .post(
          `${api_url}/transfers`,
          { from_account_id: user_a, to_account_id: user_b, amount: 1000 },
          { headers: { "idempotency-key": shared_idempotency_key } },
        )
        .catch((e) => e.response),
    );

    for (let i = 0; i < 50; i++) {
      promises.push(
        axios
          .post(
            `${api_url}/transfers`,
            { from_account_id: user_a, to_account_id: user_b, amount: 100 },
            { headers: { "idempotency-key": generate_uuid() } },
          )
          .catch((e) => e.response),
      );
      promises.push(
        axios
          .post(
            `${api_url}/transfers`,
            { from_account_id: user_b, to_account_id: user_a, amount: 50 },
            { headers: { "idempotency-key": generate_uuid() } },
          )
          .catch((e) => e.response),
      );

      if (i % 10 === 0) {
        promises.push(
          axios
            .post(
              `${api_url}/transfers`,
              {
                from_account_id: user_a,
                to_account_id: user_b,
                amount: 99999999,
              },
              { headers: { "idempotency-key": generate_uuid() } },
            )
            .catch((e) => e.response),
        );
      }
    }

    await Promise.all(promises);
    console.log("🏁 Chaos simulation completed.");

    console.log("🔍 Running Invariant Verification Audit...");
    const verification = await axios.get(`${api_url}/verification/invariants`);

    console.log("\n=============================================");
    console.log("📊 AUDIT REPORT RESULTS:");
    console.log("=============================================");
    console.log(JSON.stringify(verification.data, null, 2));
    console.log("=============================================\n");
  } catch (error: any) {
    console.error("❌ Test Harness Failed:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", error.response.data);
    } else {
      console.error(error);
    }
  }
}

run_chaos_test();
