// Krok 1: Importowanie wymaganych modułów
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
// NOWOŚĆ: Importujemy Firebase Admin SDK do wysyłki powiadomień
const admin = require('firebase-admin');

// =================================================================
// --- KONFIGURACJA SERWERA I BAZY DANYCH ---
// =================================================================

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const corsOptions = {
    origin: [
        'http://localhost:5173', 
        'http://localhost:3000', 
        'https://frontend-final-black.vercel.app',
        'https://serwer-for-render.onrender.com'
    ]
};
app.use(cors(corsOptions));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// =================================================================
// --- NOWOŚĆ: KONFIGURACJA FIREBASE ADMIN SDK ---
// =================================================================
try {
    // Render odczyta zawartość pliku klucza ze zmiennej środowiskowej
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Inicjalizacja Firebase Admin SDK zakończona pomyślnie.");
} catch (e) {
    console.error("❌ KRYTYCZNY BŁĄD: Nie udało się zainicjalizować Firebase Admin SDK. Sprawdź zmienną środowiskową FIREBASE_SERVICE_ACCOUNT_KEY.", e);
}


// =================================================================
// --- ENDPOINTY API DLA UŻYTKOWNIKÓW (USERS) ---
// =================================================================

// [BEZ ZMIAN] Bezpieczny endpoint do logowania
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0 || result.rows[0].password !== password) {
            return res.status(401).json({ message: 'Nieprawidłowa nazwa użytkownika lub hasło.' });
        }
        const user = result.rows[0];
        delete user.password;
        res.json(user);
    } catch (error) {
        console.error('Błąd [POST /api/login]:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [BEZ ZMIAN] Pobierz wszystkich użytkowników
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, role, subrole FROM users ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd [GET /api/users]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [NOWOŚĆ] Endpoint do zapisywania tokenu FCM użytkownika
app.post('/api/register-token', async (req, res) => {
    const { userId, token } = req.body;
    if (!userId || !token) {
        return res.status(400).json({ message: 'Brak userId lub tokenu.'});
    }
    try {
        await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [token, userId]);
        res.status(200).json({ message: 'Token zapisany pomyślnie.' });
    } catch (error) {
        console.error('Błąd [POST /api/register-token]:', error);
        res.status(500).json({ message: 'Błąd serwera podczas zapisywania tokenu.' });
    }
});

// [BEZ ZMIAN] Stwórz nowego użytkownika
app.post('/api/users', async (req, res) => {
  try {
    const { id, username, password, role, subRole } = req.body;
    const sql = 'INSERT INTO users (id, username, password, role, subrole) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role, subrole';
    const result = await pool.query(sql, [id, username, password, role, subRole]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Błąd [POST /api/users]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [BEZ ZMIAN] Usuń użytkownika
app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Użytkownik nie znaleziony.' });
        }
        res.status(204).send();
    } catch (error) {
        console.error(`Błąd [DELETE /api/users/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// =================================================================
// --- ZAKTUALIZOWANE ENDPOINTY API DLA ZADAŃ (TASKS) ---
// =================================================================

// [ZAKTUALIZOWANY] Pobierz zadania dla widoku kalendarza (bardziej wydajna wersja)
app.get('/api/tasks/calendar', async (req, res) => {
    try {
        const sql = `
            SELECT 
                t.*,
                creator.username as "creatorName",
                leader.username as "leaderName",
                COALESCE(asgn.users, '[]'::json) as "assignedUsers"
            FROM tasks t
            LEFT JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users leader ON t.leader_id = leader.id
            LEFT JOIN (
                SELECT ta.task_id, json_agg(u.username) as users
                FROM task_assignments ta
                JOIN users u ON u.id = ta.user_id
                GROUP BY ta.task_id
            ) asgn ON asgn.task_id = t.id
            ORDER BY t.publication_date DESC;
        `;
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (error) {
        console.error('Błąd [GET /api/tasks/calendar]:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});


// [NOWY] Endpoint do tworzenia zadania i wysyłania powiadomień
app.post('/api/tasks', async (req, res) => {
    const { title, content_state, creator_id, leader_id, deadline, importance, assignedUserIds } = req.body;
    if (!assignedUserIds || assignedUserIds.length === 0) {
        return res.status(400).json({ message: 'Musisz przypisać zadanie do co najmniej jednego użytkownika.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Rozpoczęcie transakcji
        const taskSql = `
            INSERT INTO tasks (title, content_state, creator_id, leader_id, deadline, importance) 
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
        `;
        const taskResult = await client.query(taskSql, [title, content_state, creator_id, leader_id, deadline, importance]);
        const newTask = taskResult.rows[0];
        const assignmentPromises = assignedUserIds.map(userId => {
            const assignmentSql = 'INSERT INTO task_assignments (task_id, user_id) VALUES ($1, $2)';
            return client.query(assignmentSql, [newTask.id, userId]);
        });
        await Promise.all(assignmentPromises);
        await client.query('COMMIT'); // Zatwierdzenie transakcji
        res.status(201).json(newTask);

        // Wyślij powiadomienia (poza transakcją, po pomyślnej odpowiedzi do klienta)
        console.log('Rozpoczynanie wysyłki powiadomień...');
        const tokensResult = await pool.query('SELECT fcm_token FROM users WHERE id = ANY($1::bigint[]) AND fcm_token IS NOT NULL', [assignedUserIds]);
        const tokens = tokensResult.rows.map(row => row.fcm_token);
        if (tokens.length > 0) {
            const message = {
                notification: {
                    title: 'Przypisano Ci nowe zadanie!',
                    body: `Zadanie: "${title}"`
                },
                tokens: tokens,
            };
            const response = await admin.messaging().sendEachForMulticast(message);
            console.log(`✅ Powiadomienia wysłane pomyślnie do ${response.successCount} urządzeń.`);
            if (response.failureCount > 0) {
                console.log(`❌ Nie udało się wysłać powiadomień do ${response.failureCount} urządzeń.`);
            }
        } else {
            console.log("Brak tokenów FCM dla przypisanych użytkowników. Pomijanie wysyłki powiadomień.");
        }
    } catch (error) {
        await client.query('ROLLBACK'); // Wycofanie transakcji w razie błędu
        console.error('Błąd [POST /api/tasks]:', error);
        res.status(500).json({ message: 'Błąd serwera podczas tworzenia zadania.' });
    } finally {
        client.release();
    }
});


// [NOWY] Endpoint do zapisywania postępu zadania (przycisk "Save")
app.put('/api/tasks/:id/save', async (req, res) => {
    try {
        const { id } = req.params;
        const { content_state } = req.body;
        const sql = 'UPDATE tasks SET content_state = $1 WHERE id = $2 RETURNING *';
        const result = await pool.query(sql, [content_state, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/tasks/${req.params.id}/save]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [NOWY] Endpoint do zmiany terminu zadania
app.put('/api/tasks/:id/deadline', async (req, res) => {
    try {
        const { id } = req.params;
        const { deadline } = req.body;
        const sql = 'UPDATE tasks SET deadline = $1 WHERE id = $2 RETURNING *';
        const result = await pool.query(sql, [deadline, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/tasks/${req.params.id}/deadline]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [NOWY] Endpoint do usuwania zadań
app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Dzięki "ON DELETE CASCADE" w bazie danych, usunięcie zadania
        // automatycznie usunie powiązane z nim przypisania z tabeli task_assignments.
        const result = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        }
        res.status(204).send();
    } catch (error) {
        console.error(`Błąd [DELETE /api/tasks/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// =================================================================
// --- ENDPOINTY DLA STATYSTYK (BEZ ZMIAN) ---
// =================================================================

// [BEZ ZMIAN] Pobierz wszystkie statystyki
app.get('/api/statystyki', async (req, res) => {
  try {
    const { rodzaj_produktu } = req.query;
    let sql = 'SELECT * FROM statystyka_sprzedazy';
    const params = [];
    if (rodzaj_produktu) {
      sql += ' WHERE rodzaj_produktu = $1';
      params.push(rodzaj_produktu);
    }
    sql += ' ORDER BY rok, rodzaj_produktu, miesiac ASC';
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd [GET /api/statystyki]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [BEZ ZMIAN] Zaktualizuj ilość w statystyce
app.put('/api/statystyki/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { ilosc } = req.body;
        if (ilosc === undefined) {
            return res.status(400).json({ message: 'Brakująca wartość "ilosc" w zapytaniu.' });
        }
        const sql = 'UPDATE statystyka_sprzedazy SET ilosc = $1 WHERE id = $2 RETURNING *';
        const result = await pool.query(sql, [ilosc, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Rekord statystyki nie został znaleziony.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/statystyki/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [BEZ ZMIAN] Stwórz nowy wpis w statystykach
app.post('/api/statystyki', async (req, res) => {
  try {
    const { rok, miesiac, ilosc, rodzaj_produktu } = req.body;
    if (!rodzaj_produktu) {
        return res.status(400).json({ message: 'Brakująca wartość "rodzaj_produktu" w zapytaniu.' });
    }
    const sql = 'INSERT INTO statystyka_sprzedazy (rok, miesiac, ilosc, rodzaj_produktu) VALUES ($1, $2, $3, $4) RETURNING *';
    const result = await pool.query(sql, [rok, miesiac, ilosc, rodzaj_produktu]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Błąd [POST /api/statystyki]:', error);
    if (error.code === '23505') {
        return res.status(409).json({ message: 'Wpis dla tego produktu, roku i miesiąca już istnieje.' });
    }
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// =================================================================
// --- URUCHOMIENIE SERWERA ---
// =================================================================
app.listen(PORT, () => {
  console.log(`Serwer nasłuchuje na porcie ${PORT}`);
});