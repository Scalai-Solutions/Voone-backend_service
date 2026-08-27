import { buildApp } from "./app";
import { config } from "./config/env";

const app = buildApp();

app.listen(config.PORT, () => {
  console.log(`Voone backend listening at http://localhost:${config.PORT}`);
});
