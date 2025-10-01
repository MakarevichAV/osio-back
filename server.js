const express = require("express");
const ModbusRTU = require("modbus-serial");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const client = new ModbusRTU();
const PLC_IP = "192.168.0.10"; // твой IP PLC
const PORT = 502;

// подключаемся к PLC
client.connectTCP(PLC_IP, { port: PORT })
    .then(() => console.log("Connected to PLC"))
    .catch(err => console.log("PLC connection error:", err));

// обычный REST API (чтобы можно было тестировать через браузер)
app.get("/api/holding/:start/:length", async (req, res) => {
    const { start, length } = req.params;
    try {
        const data = await client.readHoldingRegisters(Number(start), Number(length));
        res.json({ values: data.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// real-time через WebSocket
setInterval(async () => {
    try {
        // читаем первые 4 регистра (пример)
        const data = await client.readHoldingRegisters(0, 4);
        // const holdingData = await client.readHoldingRegisters(0, 4);
        // const coilsData = await client.readCoils(0, 8);
        // const inputsData = await client.readDiscreteInputs(0, 8);
        io.emit("plc-data", { values: data.data });
    } catch (err) {
        console.error("PLC read error:", err.message);
    }
}, 300); // опрашиваем PLC каждые 0.3 сек

server.listen(3001, () => console.log("Backend + WebSocket running on port 3001"));