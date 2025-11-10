const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

const JWT_SECRET = 'mi-clave-secreta-para-el-proyecto-123';

const pool = mysql.createPool({
    host: 'tramway.proxy.rlwy.net',
    user: 'root',
    password: 'RCGvIpjRpPRlbQjLSWafZxwQPiXjjIfI', // <-- ¡PON TU CONTRASEÑA!
    database: 'railway',
    port: 36227, // <-- ¡PON EL PUERTO PÚBLICO!
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00' 
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });



// 1. /api/products (Sin cambios)
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM Products');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error de BD' }); }
});

// 2. /api/login (Sin cambios)
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
        const [rows] = await pool.query('SELECT * FROM Users WHERE email = ?', [email]);
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }
        const token = jwt.sign({ userId: user.user_id, role: user.role }, JWT_SECRET, { expiresIn: '2h' });
        res.json({
            message: 'Login exitoso', token,
            user: { name: user.name, email: user.email, role: user.role }
        });
    } catch (error) { res.status(500).json({ error: 'Error de servidor' }); }
});

// 3. /api/inventory (Sin cambios)
app.get('/api/inventory', async (req, res) => {
    try {
        const query = `
            WITH ProductStoreMatrix AS (
                SELECT p.product_id, s.store_id FROM Products p CROSS JOIN Stores s
            )
            SELECT
                p.product_id, p.name, p.price, p.image_url,
                JSON_ARRAYAGG(
                    JSON_OBJECT('store_id', s.store_id, 'store_name', s.name, 'stock', COALESCE(ps.stock, 0))
                ) AS stock_by_store
            FROM Products p
            JOIN ProductStoreMatrix m ON p.product_id = m.product_id
            JOIN Stores s ON m.store_id = s.store_id
            LEFT JOIN Product_Stock ps ON m.product_id = ps.product_id AND m.store_id = ps.store_id
            GROUP BY p.product_id, p.name, p.price, p.image_url;
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error de BD' }); }
});

// 4. /api/stock/update (Sin cambios)
app.post('/api/stock/update', async (req, res) => {
    try {
        const { productId, storeId, newStock } = req.body;
        if (!storeId || !productId) return res.status(400).json({ error: 'IDs nulos' });
        if (newStock < 0) return res.status(400).json({ error: 'Stock no puede ser negativo' });
        await pool.query(
            `INSERT INTO Product_Stock (product_id, store_id, stock) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE stock = ?`,
            [productId, storeId, newStock, newStock]
        );
        res.json({ message: 'Stock actualizado' });
    } catch (error) { res.status(500).json({ error: 'Error de BD' }); }
});

// 5. /api/inventory/transfer (Sin cambios)
app.post('/api/inventory/transfer', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { productId, fromStoreId, toStoreId, quantity } = req.body;
        await connection.beginTransaction();
        const [originStockRows] = await connection.query('SELECT stock FROM Product_Stock WHERE product_id = ? AND store_id = ? FOR UPDATE', [productId, fromStoreId]);
        const currentStock = (originStockRows.length > 0) ? originStockRows[0].stock : 0;
        if (currentStock < quantity) throw new Error('Stock insuficiente');
        await connection.query('UPDATE Product_Stock SET stock = stock - ? WHERE product_id = ? AND store_id = ?', [quantity, productId, fromStoreId]);
        await connection.query(`INSERT INTO Product_Stock (product_id, store_id, stock) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE stock = stock + ?`, [productId, toStoreId, quantity, quantity]);
        await connection.commit();
        res.json({ message: 'Transferencia completada' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message || 'Error en transferencia' });
    } finally {
        connection.release();
    }
});

// 6. /api/checkout (Sin cambios)
app.post('/api/checkout', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { storeId, customerId, items } = req.body;
        const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        await connection.beginTransaction();
        const [saleResult] = await connection.query('INSERT INTO Sales (customer_id, store_id, total_amount) VALUES (?, ?, ?)', [customerId, storeId, totalAmount]);
        const saleId = saleResult.insertId;
        for (const item of items) {
            await connection.query('INSERT INTO Sale_Details (sale_id, product_id, quantity, price_per_unit) VALUES (?, ?, ?, ?)', [saleId, item.productId, item.quantity, item.price]);
            const [stockCheck] = await connection.query('SELECT stock FROM Product_Stock WHERE product_id = ? AND store_id = ? FOR UPDATE', [item.productId, storeId]);
            if (stockCheck.length === 0 || stockCheck[0].stock < item.quantity) throw new Error(`Stock insuficiente para ID ${item.productId}.`);
            await connection.query('UPDATE Product_Stock SET stock = stock - ? WHERE product_id = ? AND store_id = ?', [item.quantity, item.productId, storeId]);
        }
        await connection.commit();
        res.json({ message: 'Compra realizada', saleId: saleId });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message || 'Error al procesar compra' });
    } finally {
        connection.release();
    }
});

// 7. /api/products/:id/upload (Sin cambios)
app.post('/api/products/:id/upload', upload.single('productImage'), async (req, res) => {
    try {
        const productId = req.params.id;
        if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
        const imageUrl = `http://localhost:4000/uploads/${req.file.filename}`;
        await pool.query('UPDATE Products SET image_url = ? WHERE product_id = ?', [imageUrl, productId]);
        res.json({ message: 'Imagen subida', imageUrl: imageUrl });
    } catch (error) { res.status(500).json({ error: 'Error al subir imagen' }); }
});

// 8. /api/reports/low-stock (Sin cambios)
app.get('/api/reports/low-stock', async (req, res) => {
    try {
        const query = `
            SELECT p.name as productName, s.name as storeName, ps.stock
            FROM Product_Stock ps
            JOIN Products p ON ps.product_id = p.product_id
            JOIN Stores s ON ps.store_id = s.store_id
            WHERE ps.stock < 10 AND ps.stock > 0
            ORDER BY ps.stock ASC LIMIT 20
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error de BD' }); }
});

// 9. /api/reports/top-sold (Sin cambios)
app.get('/api/reports/top-sold', async (req, res) => {
    try {
        const query = `
            SELECT p.name as productName, 'General' as storeName, SUM(sd.quantity) as totalSold
            FROM Sale_Details sd
            JOIN Products p ON sd.product_id = p.product_id
            GROUP BY p.product_id
            ORDER BY totalSold DESC LIMIT 100
        `;
        const [rows] = await pool.query(query);
        if (rows.length === 0) {
             return res.json([{ productName: 'Producto Simulado A (Sin Ventas)', storeName: 'General', totalSold: 150 }]);
        }
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error de BD' }); }
});

// 10. /api/reports/sales-by-month (Sin cambios)
app.get('/api/reports/sales-by-month', async (req, res) => {
    try {
        const query = `
            WITH TopProducts AS (
                SELECT p.product_id, p.name, SUM(sd.quantity) as total_sold
                FROM Sale_Details sd JOIN Products p ON sd.product_id = p.product_id
                GROUP BY p.product_id, p.name ORDER BY total_sold DESC LIMIT 5
            ),
            Months AS (
                SELECT 1 as month_num, 'Enero' as month_name UNION ALL SELECT 2, 'Febrero' UNION ALL
                SELECT 3, 'Marzo' UNION ALL SELECT 4, 'Abril' UNION ALL SELECT 5, 'Mayo' UNION ALL
                SELECT 6, 'Junio' UNION ALL SELECT 7, 'Julio' UNION ALL SELECT 8, 'Agosto' UNION ALL
                SELECT 9, 'Septiembre' UNION ALL SELECT 10, 'Octubre' UNION ALL SELECT 11, 'Noviembre' UNION ALL
                SELECT 12, 'Diciembre'
            )
            SELECT
                tp.name, m.month_name, m.month_num,
                COALESCE(SUM(sd.quantity), 0) as monthly_sales
            FROM TopProducts tp
            CROSS JOIN Months m
            LEFT JOIN Sales s ON MONTH(s.sale_date) = m.month_num AND YEAR(s.sale_date) = YEAR(CURDATE())
            LEFT JOIN Sale_Details sd ON s.sale_id = sd.sale_id AND sd.product_id = tp.product_id
            GROUP BY tp.name, m.month_name, m.month_num
            ORDER BY tp.name, m.month_num;
        `;
        const [rows] = await pool.query(query);

        if (rows.length === 0) {
            return res.json({
                labels: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
                datasets: [{
                    label: 'Sin Ventas Registradas este Año',
                    data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    backgroundColor: 'rgba(200, 200, 200, 0.5)'
                }]
            });
        }

        const datasetsMap = new Map();
        const colors = ['rgba(255, 99, 132, 0.5)', 'rgba(54, 162, 235, 0.5)', 'rgba(255, 206, 86, 0.5)', 'rgba(75, 192, 192, 0.5)', 'rgba(153, 102, 255, 0.5)'];
        let colorIndex = 0;

        for (const row of rows) {
            if (!datasetsMap.has(row.name)) {
                datasetsMap.set(row.name, {
                    label: row.name,
                    data: new Array(12).fill(0),
                    backgroundColor: colors[colorIndex % colors.length]
                });
                colorIndex++;
            }
            datasetsMap.get(row.name).data[row.month_num - 1] = row.monthly_sales;
        }

        res.json({
            labels: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
            datasets: Array.from(datasetsMap.values())
        });
    } catch (error) {
        console.error("Error en reporte sales-by-month:", error);
        res.status(500).json({ error: 'Error de BD' });
    }
});


// --- ¡NUEVO ENDPOINT PARA REPORTE POR FECHAS! ---
// 11. /api/reports/sales-by-date
app.get('/api/reports/sales-by-date', async (req, res) => {
    try {
        let { startDate, endDate } = req.query;

        // Validar fechas
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Se requieren fecha de inicio y fin' });
        }

        // Asegurarse de que endDate incluya todo el día (hasta 23:59:59)
        endDate = `${endDate} 23:59:59`;

        const query = `
            SELECT 
                s.sale_id,
                DATE_FORMAT(s.sale_date, '%Y-%m-%d %H:%i') as sale_date, -- Formatea la fecha
                c.name as customer_name,
                st.name as store_name,
                s.total_amount
            FROM Sales s
            JOIN Customers c ON s.customer_id = c.customer_id
            JOIN Stores st ON s.store_id = st.store_id
            WHERE s.sale_date BETWEEN ? AND ?
            ORDER BY s.sale_date DESC;
        `;
        
        const [rows] = await pool.query(query, [startDate, endDate]);
        res.json(rows);

    } catch (error) {
        console.error("Error en reporte sales-by-date:", error);
        res.status(500).json({ error: 'Error de BD' });
    }
});


app.listen(PORT, () => {
    console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
});