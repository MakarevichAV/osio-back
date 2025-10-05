const express = require("express");
const ModbusRTU = require("modbus-serial");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse");

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


let recipesJson = null; // глобальная переменная

const filePath = path.join(__dirname, "RecipeData", "RecipeData.csv");

// функция для парсинга CSV и обновления recipesJson
function loadRecipes() {
    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) {
            console.error("Ошибка чтения CSV:", err);
            return;
        }

        parse(data, { relaxColumnCount: true }, (err, records) => {
            if (err) {
                console.error("Ошибка парсинга CSV:", err);
                return;
            }

            // фильтрация служебных строк
            const filtered = records.filter(
                row =>
                    row[0] &&
                    !row[0].startsWith("#") &&
                    !row[0].startsWith("RecipeName:") &&
                    !row[0].startsWith("setSize:") &&
                    !row[0].startsWith("id:")
            );

            if (filtered.length === 0) {
                recipesJson = { headers: [], sets: [] };
                return;
            }

            const headers = filtered[0];
            const sets = filtered.slice(1).map(row => {
                let obj = {};
                headers.forEach((h, i) => {
                    obj[h] = row[i];
                });
                return obj;
            });

            recipesJson = { headers, sets };
            console.log("Recipes loaded");
        });
    });
}

// загружаем при старте сервера
loadRecipes();

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

        io.emit("plc-data", { values: data.data });
    } catch (err) {
        console.error("PLC read error:", err.message);
    }
}, 300); // опрашиваем PLC каждые 0.3 сек

function scaleValue(val, type) {
    let v = parseFloat(val) || 0;
    switch (type) {
        case "Angle": return Math.round(v * 10);   // -40.0..40.0 → -400..400
        case "DeltaX": return Math.round(v * 10);  // 0.0..15.0 → 0..150
        case "Z": return Math.round(v * 10);       // 0.0..50.0 → 0..500
        case "RPM":
        case "Idle":
        default: return Math.round(v);             // целые
    }
}

// Преобразование INT16 signed в UINT16 для Modbus
function int16ToUInt16(value) {
    return value & 0xFFFF;
}

// Преобразование float32 в два регистра Modbus
function floatToRegisters(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    return [buf.readUInt16BE(2), buf.readUInt16BE(0)]; // little-endian
}

async function sendSetToPLC(setName, recipeData) {
    try {
        const angles = [];
        const deltaXRegisters = [];
        const zStartRegisters = [];
        const zEndRegisters = [];
        const rpmRegisters = [];
        const idle = []

        for (const row of recipeData.sets) {
            const val = parseFloat(row[setName]) || 0;

            if (row.ElementName.startsWith("Angle")) angles.push(int16ToUInt16(scaleValue(val, "Angle")));
            else if (row.ElementName.startsWith("DeltaX")) deltaXRegisters.push(...floatToRegisters(scaleValue(val, "DeltaX")));
            else if (row.ElementName.startsWith("Z_Start")) zStartRegisters.push(...floatToRegisters(scaleValue(val, "Z")));
            else if (row.ElementName.startsWith("Z_End")) zEndRegisters.push(...floatToRegisters(scaleValue(val, "Z")));
            else if (row.ElementName.startsWith("RPM")) rpmRegisters.push(...floatToRegisters(scaleValue(val, "RPM")));
            else if (row.ElementName.startsWith("Idle")) idle.push(int16ToUInt16(scaleValue(val, "Idle")));
        }

        // console.log(`\n=== Отладка перед отправкой сета "${setName}" ===`);
        // console.log("Angles:", angles, "длина:", angles.length);
        // console.table(angles);
        //
        // console.log("DeltaXRegisters:", deltaXRegisters, "длина:", deltaXRegisters.length / 2, "(float32 элементов)");
        // console.log("Z_StartRegisters:", zStartRegisters, "длина:", zStartRegisters.length / 2);
        // console.log("Z_EndRegisters:", zEndRegisters, "длина:", zEndRegisters.length / 2);
        // console.log("RPMRegisters:", rpmRegisters, "длина:", rpmRegisters.length / 2);
        // console.log("Idle:", idle, "длина:", idle.length);

        // Запись в PLC
        await client.writeRegisters(100, angles);          // Angle1..30 (INT16)
        await client.writeRegisters(130, deltaXRegisters); // DeltaX1..30 (float32 → 2 регистра на элемент)
        await client.writeRegisters(190, zStartRegisters); // Z_Start1..30 (float32)
        await client.writeRegisters(250, zEndRegisters);   // Z_End1..30 (float32)
        await client.writeRegisters(310, rpmRegisters);    // RPM1..30 (float32)
        await client.writeRegisters(370, idle);            // Idle1..30 (INT16)

        console.log(`Set ${setName} успешно отправлен в ПЛК`);
    } catch (err) {
        console.error("Ошибка отправки в ПЛК:", err);
    }
}

app.post("/api/sendSet/:setName", async (req, res) => {
    const { setName } = req.params;
    try {
        await sendSetToPLC(setName, recipesJson); // recipesJson хранится в памяти сервера
        res.json({ status: "ok" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

server.listen(3001, () => console.log("Backend + WebSocket running on port 3001"));


// const holdingData = await client.readHoldingRegisters(0, 4);
// const coilsData = await client.readCoils(0, 8);
// const inputsData = await client.readDiscreteInputs(0, 8);


// getting parsed RecipeData.csv for client
app.get("/api/recipes", (req, res) => {
    if (!recipesJson) return res.status(500).json({ error: "Recipes not loaded" });
    res.json(recipesJson);
});