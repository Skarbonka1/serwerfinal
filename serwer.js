// Krok 1: Importowanie wymaganych modułów
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
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
// --- KONFIGURACJA FIREBASE ADMIN SDK ---
// =================================================================
try {
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
// Ta sekcja pozostaje bez zmian
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

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, role, subrole FROM users ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd [GET /api/users]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

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

// NOWY Endpoint do edycji użytkownika
app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, role, subrole } = req.body;

        // Prosta walidacja, czy mamy jakiekolwiek dane do aktualizacji
        if (!username || !role) {
            return res.status(400).json({ message: 'Nazwa użytkownika i rola są wymagane.' });
        }

        const sql = `
            UPDATE users 
            SET username = $1, role = $2, subrole = $3 
            WHERE id = $4 
            RETURNING id, username, role, subrole;
        `;
        
        const result = await pool.query(sql, [username, role, subrole, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Użytkownik nie znaleziony.' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/users/${req.params.id}]:`, error);
        // Obsługa błędu unikalności nazwy użytkownika
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Użytkownik o tej nazwie już istnieje.' });
        }
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

// [ZMODYFIKOWANY] Pobiera zadania widoczne TYLKO dla konkretnego użytkownika
app.get('/api/tasks/calendar', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ message: 'Brak ID użytkownika.' });
    }

    try {
        // ### ZAPYTANIE Z POPRAWIONĄ LOGIKĄ WIDOCZNOŚCI ###
        const sql = `
            SELECT 
                t.*,
                COALESCE(creator.username, 'Nieznany') as "creatorName",
                COALESCE(leader.username, 'Brak') as "leaderName",
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
            WHERE 
                -- Pokaż zadanie, jeśli jest opublikowane I (jesteś jego twórcą LUB jesteś do niego przypisany)
                (t.status = 'w toku' AND (t.creator_id = $1 OR t.id IN (SELECT task_id FROM task_assignments WHERE user_id = $1)))
                OR 
                -- LUB pokaż zadanie, jeśli jest szkicem stworzonym przez tego użytkownika
                (t.status = 'draft' AND t.creator_id = $1)
            ORDER BY t.publication_date DESC;
        `;
        const result = await pool.query(sql, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Błąd [GET /api/tasks/calendar]:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});


// [BEZ ZMIAN] Tworzy zadanie jako szkic
app.post('/api/tasks', async (req, res) => {
    const { title, content_state, creator_id, leader_id, deadline, importance, assignedUserIds } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const taskSql = `
            INSERT INTO tasks (id, title, content_state, creator_id, leader_id, deadline, importance, status, publication_date) 
            VALUES (COALESCE((SELECT MAX(id) FROM tasks), 0) + 1, $1, $2, $3, $4, $5, $6, 'draft', NOW()) RETURNING *;
        `;
        const params = [
            title || 'Nowy szkic',
            content_state,
            parseInt(creator_id, 10),
            leader_id ? parseInt(leader_id, 10) : null,
            deadline || null,
            importance
        ];
        
        const taskResult = await client.query(taskSql, params);
        const newTask = taskResult.rows[0];

        if (assignedUserIds && assignedUserIds.length > 0) {
            const assignmentPromises = assignedUserIds.map(userId => {
                const assignmentSql = 'INSERT INTO task_assignments (task_id, user_id) VALUES ($1, $2)';
                return client.query(assignmentSql, [newTask.id, userId]);
            });
            await Promise.all(assignmentPromises);
        }
        
        await client.query('COMMIT');
        res.status(201).json(newTask);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Błąd [POST /api/tasks]:', error);
        res.status(500).json({ message: 'Błąd serwera podczas tworzenia szkicu zadania.' });
    } finally {
        client.release();
    }
});

// [BEZ ZMIAN] Aktualizuje zadanie
app.put('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const { title, content_state, leader_id, deadline, importance, assignedUserIds } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const taskSql = `
            UPDATE tasks SET title = $1, content_state = $2, leader_id = $3, deadline = $4, importance = $5
            WHERE id = $6 RETURNING *;
        `;
        const params = [
            title,
            content_state,
            leader_id ? parseInt(leader_id, 10) : null,
            deadline || null,
            importance,
            id
        ];
        const taskResult = await client.query(taskSql, params);
        if (taskResult.rowCount === 0) {
            return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        }

        await client.query('DELETE FROM task_assignments WHERE task_id = $1', [id]);
        if (assignedUserIds && assignedUserIds.length > 0) {
            const assignmentPromises = assignedUserIds.map(userId => {
                const assignmentSql = 'INSERT INTO task_assignments (task_id, user_id) VALUES ($1, $2)';
                return client.query(assignmentSql, [id, userId]);
            });
            await Promise.all(assignmentPromises);
        }
        
        await client.query('COMMIT');
        res.json(taskResult.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Błąd [PUT /api/tasks/${id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera podczas aktualizacji zadania.' });
    } finally {
        client.release();
    }
});

// [ZAKTUALIZOWANY] Publikuje zadanie i wysyła powiadomienia
app.post('/api/tasks/:id/publish', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const taskResult = await client.query("UPDATE tasks SET status = 'w toku', publication_date = NOW() WHERE id = $1 RETURNING *", [id]);
        if (taskResult.rowCount === 0) {
            return res.status(404).json({ message: 'Zadanie do publikacji nie znalezione.' });
        }
        const task = taskResult.rows[0];

        const assignmentsResult = await client.query('SELECT user_id FROM task_assignments WHERE task_id = $1', [id]);
        const assignedUserIds = assignmentsResult.rows.map(r => r.user_id);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Zadanie opublikowane.' });

        // LOGIKA WYSYŁANIA POWIADOMIEŃ
        if (assignedUserIds.length > 0) {
            const tokensResult = await pool.query('SELECT fcm_token FROM users WHERE id = ANY($1::bigint[]) AND fcm_token IS NOT NULL', [assignedUserIds]);
            const tokens = tokensResult.rows.map(row => row.fcm_token);
            if (tokens.length > 0) {
                const message = {
                    notification: {
                        title: 'Przypisano Ci nowe zadanie!',
                        body: `Zadanie: "${task.title}"`
                    },
                    tokens: tokens,
                };
                await admin.messaging().sendEachForMulticast(message);
                console.log(`✅ Powiadomienia wysłane do ${tokens.length} urządzeń.`);
            }
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Błąd [POST /api/tasks/${id}/publish]:`, error);
        res.status(500).json({ message: 'Błąd serwera podczas publikacji zadania.' });
    } finally {
        client.release();
    }
});


// [BEZ ZMIAN] Endpoint do usuwania zadań
app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        res.status(204).send();
    } catch (error) {
        console.error(`Błąd [DELETE /api/tasks/${id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [BEZ ZMIAN] Endpoint do zmiany terminu zadania
app.put('/api/tasks/:id/deadline', async (req, res) => {
    try {
        const { id } = req.params;
        const { deadline } = req.body;
        const sql = 'UPDATE tasks SET deadline = $1 WHERE id = $2 RETURNING *';
        const result = await pool.query(sql, [deadline || null, id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// =================================================================
// --- ENDPOINTY DLA STATYSTYK (BEZ ZMIAN) ---
// =================================================================

// [ZMODYFIKOWANY] Pobierz wszystkie statystyki, sortowanie uwzględnia nowe pola
app.get('/api/statystyki', async (req, res) => {
  try {
    const sql = 'SELECT * FROM statystyka_sprzedazy ORDER BY rok, miesiac, tydzien, dzien, rodzaj_produktu ASC';
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd [GET /api/statystyki]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [ZMODYFIKOWANY] Zaktualizuj wpis w statystyce (dodano tydzien i dzien)
app.put('/api/statystyki/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { ilosc, tydzien, dzien } = req.body; // Pobieramy nowe pola
        
        // Budujemy zapytanie dynamicznie, aby aktualizować tylko te pola, które zostały przesłane
        const fieldsToUpdate = [];
        const values = [];
        let queryIndex = 1;

        if (ilosc !== undefined) {
            fieldsToUpdate.push(`ilosc = $${queryIndex++}`);
            values.push(ilosc);
        }
        if (tydzien !== undefined) {
            fieldsToUpdate.push(`tydzien = $${queryIndex++}`);
            values.push(tydzien || null); // Zamień pusty string na NULL
        }
        if (dzien !== undefined) {
            fieldsToUpdate.push(`dzien = $${queryIndex++}`);
            values.push(dzien || null); // Zamień pusty string na NULL
        }

        if (fieldsToUpdate.length === 0) {
            return res.status(400).json({ message: 'Brak danych do aktualizacji.' });
        }

        values.push(id); // Dodaj ID na końcu jako ostatni parametr
        const sql = `UPDATE statystyka_sprzedazy SET ${fieldsToUpdate.join(', ')} WHERE id = $${queryIndex} RETURNING *`;
        
        const result = await pool.query(sql, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Rekord statystyki nie został znaleziony.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/statystyki/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [ZMODYFIKOWANY] Stwórz nowy wpis w statystykach (dodano tydzien i dzien)
app.post('/api/statystyki', async (req, res) => {
  try {
    const { rok, miesiac, tydzien, dzien, ilosc, rodzaj_produktu } = req.body;
    if (!rodzaj_produktu) {
        return res.status(400).json({ message: 'Brakująca wartość "rodzaj_produktu" w zapytaniu.' });
    }
    const sql = `
        INSERT INTO statystyka_sprzedazy (rok, miesiac, tydzien, dzien, ilosc, rodzaj_produktu) 
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `;
    // Upewniamy się, że puste wartości są zamieniane na NULL
    const params = [rok, miesiac, tydzien || null, dzien || null, ilosc, rodzaj_produktu];
    const result = await pool.query(sql, params);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Błąd [POST /api/statystyki]:', error);
    if (error.code === '23505') {
        return res.status(409).json({ message: 'Wpis dla tego produktu, roku i miesiąca już istnieje.' });
    }
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// Uruchomienie serwera
app.listen(PORT, () => {
  console.log(`Serwer nasłuchuje na porcie ${PORT}`);
});