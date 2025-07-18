// Krok 1: Importowanie wymaganych modułów
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();

// --- NOWA LINIA ---
// Konfiguracja zaufanego proxy. Render działa jako "proxy", więc musimy powiedzieć
// Expressowi, aby ufał informacjom przesyłanym przez Render (np. o prawdziwym
// adresie IP użytkownika). Jest to wymagane, aby express-rate-limit działał poprawnie.
app.set('trust proxy', 1);

// Krok 2: Konfiguracja gotowa na Render
const PORT = process.env.PORT || 3001;

// Krok 3: Konfiguracja połączenia z bazą danych PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Krok 4: Konfiguracja zabezpieczeń (CORS i Rate Limiter)
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minut
    max: 100, // Limit 100 zapytań na 15 minut dla jednego adresu IP
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Zbyt wiele zapytań z tego IP, spróbuj ponownie za 15 minut.'
});

app.use('/api', limiter);

// Krok 5: Endpointy API oparte na bazie danych

// --- PEŁNA OBSŁUGA UŻYTKOWNIKÓW (CRUD) ---

// READ: Pobieranie wszystkich użytkowników
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd przy pobieraniu użytkowników:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// CREATE: Dodawanie nowego użytkownika
app.post('/api/users', async (req, res) => {
  try {
    const { name } = req.body; // Oczekujemy obiektu z polem 'name'
    if (!name) {
      return res.status(400).json({ message: 'Nazwa użytkownika jest wymagana.' });
    }
    const sql = 'INSERT INTO users (name) VALUES ($1) RETURNING *';
    const result = await pool.query(sql, [name]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Błąd przy dodawaniu użytkownika:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});


// --- PEŁNA OBSŁUGA ZADAŃ (CRUD) ---

// READ: Pobieranie wszystkich zadań
app.get('/api/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Błąd przy pobieraniu zadań:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// CREATE: Dodawanie nowego zadania
app.post('/api/tasks', async (req, res) => {
  try {
    const { text, user_id } = req.body;
    if (!text || !user_id) {
      return res.status(400).json({ message: 'Tekst zadania oraz user_id są wymagane.' });
    }
    const sql = 'INSERT INTO tasks (text, completed, user_id) VALUES ($1, $2, $3) RETURNING *';
    const values = [text, false, user_id];
    const result = await pool.query(sql, values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Błąd przy dodawaniu zadania:', error);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// UPDATE: Aktualizacja istniejącego zadania
app.put('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { text, completed } = req.body;

        const sql = 'UPDATE tasks SET text = $1, completed = $2 WHERE id = $3 RETURNING *';
        const values = [text, completed, id];
        const result = await pool.query(sql, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Nie znaleziono zadania o podanym ID.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Błąd przy aktualizacji zadania:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});

// DELETE: Usuwanie zadania
app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Nie znaleziono zadania o podanym ID.' });
        }
        res.status(204).send();
    } catch (error) {
        console.error('Błąd przy usuwaniu zadania:', error);
        res.status(500).json({ message: 'Błąd serwera.' });
    }
});


// Krok 6: Uruchomienie serwera
app.listen(PORT, () => {
  console.log(`Serwer nasłuchuje na porcie ${PORT}`);
});
