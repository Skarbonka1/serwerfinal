// Krok 1: Importowanie wymaganych modułów
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', limiter);

// =================================================================
// --- ENDPOINTY API DLA UŻYTKOWNIKÓW (USERS) - bez zmian ---
// =================================================================

// [NEW] Bezpieczny endpoint do logowania
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const sql = 'SELECT * FROM users WHERE username = $1';
        const result = await pool.query(sql, [username]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Nieprawidłowa nazwa użytkownika lub hasło.' });
        }
        const user = result.rows[0];
        if (user.password !== password) {
            return res.status(401).json({ message: 'Nieprawidłowa nazwa użytkownika lub hasło.' });
        }
        delete user.password;
        res.json(user);
    } catch (error) {
        console.error('Błąd [POST /api/login]:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [READ] Pobierz wszystkich użytkowników
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, role, subrole FROM users ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd [GET /api/users]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [CREATE] Stwórz nowego użytkownika
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

// [UPDATE] Zaktualizuj użytkownika
app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, role, subrole } = req.body;
        const sql = 'UPDATE users SET username = $1, role = $2, subrole = $3 WHERE id = $4 RETURNING id, username, role, subrole';
        const result = await pool.query(sql, [username, role, subrole, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Użytkownik nie znaleziony.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/users/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [DELETE] Usuń użytkownika
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
// --- ENDPOINTY API DLA ZADAŃ (TASKS) - ZAKTUALIZOWANE ---
// =================================================================

// [READ] Pobierz wszystkie zadania wraz z ich komentarzami
app.get('/api/tasks', async (req, res) => {
  try {
    // ZMIANA: Dodajemy t.content i t.is_completed do listy pobieranych pól
    const sql = `
      SELECT
        t.id, t.title, t.content, t.is_completed, t.deadline, t.user_id as "assignedTo",
        COALESCE(
          (SELECT json_agg(json_build_object('id', c.id, 'by', c.author_username, 'text', c.text, 'status', c.status) ORDER BY c.created_at ASC)
           FROM comments c WHERE c.task_id = t.id),
          '[]'::json
        ) as comments
      FROM tasks t ORDER BY t.id ASC;
    `;
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd [GET /api/tasks]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [CREATE] Stwórz nowe zadanie
app.post('/api/tasks', async (req, res) => {
  try {
    // ZMIANA: Odbieramy 'content' z ciała zapytania. 'is_completed' ma wartość domyślną w bazie.
    const { id, title, content, deadline, assignedTo } = req.body;
    const sql = 'INSERT INTO tasks (id, title, content, deadline, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *';
    const result = await pool.query(sql, [id, title, content, deadline, assignedTo]);
    const newTask = { ...result.rows[0], assignedTo: result.rows[0].user_id, comments: [] };
    res.status(201).json(newTask);
  } catch (error) {
    console.error('Błąd [POST /api/tasks]:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// [UPDATE] Zaktualizuj zadanie
app.put('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // ZMIANA: Pozwalamy na aktualizację 'content' i 'is_completed'
        const { title, content, is_completed, deadline, assignedTo } = req.body;
        const sql = 'UPDATE tasks SET title = $1, content = $2, is_completed = $3, deadline = $4, user_id = $5 WHERE id = $6 RETURNING *';
        const result = await pool.query(sql, [title, content, is_completed, deadline, assignedTo, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Zadanie nie znalezione.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(`Błąd [PUT /api/tasks/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [DELETE] Usuń zadanie (bez zmian)
app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
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
// --- ENDPOINTY API DLA KOMENTARZY (COMMENTS) - bez zmian ---
// =================================================================

// [CREATE] Stwórz nowy komentarz
app.post('/api/comments', async (req, res) => {
    try {
        const { taskId, author, text, status } = req.body;
        const sql = 'INSERT INTO comments (task_id, author_username, text, status) VALUES ($1, $2, $3, $4) RETURNING *';
        const result = await pool.query(sql, [taskId, author, text, status]);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Błąd [POST /api/comments]:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// [DELETE] Usuń komentarz
app.delete('/api/comments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM comments WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Komentarz nie znaleziony.' });
        }
        res.status(204).send();
    } catch (error) {
        console.error(`Błąd [DELETE /api/comments/${req.params.id}]:`, error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});


// Uruchomienie serwera
app.listen(PORT, () => {
  console.log(`Serwer nasłuchuje na porcie ${PORT}`);
});