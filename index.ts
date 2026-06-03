import express from "express";
import appController from "./src/app.controller.js";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

appController(app);

app.listen(port, () => console.log(`Example app listening on port ${port}!`));
