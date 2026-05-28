import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lotteryRouter from "./lottery";
import telegramRouter from "./telegram";
import authRouter from "./auth";
import cardRouter from "./card";
import adminRouter from "./admin";
import shopRouter from "./shop";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(cardRouter);
router.use(adminRouter);
router.use(lotteryRouter);
router.use(telegramRouter);
router.use(shopRouter);

export default router;
