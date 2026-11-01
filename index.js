require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const axios = require("axios");
const path = require("path");
const db = require("./db");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

// ========== Routes ==========

app.get("/", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  res.render("home");
});

app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", async (req, res) => {
  const { username, email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await db.query(
      "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
      [username, email, hashedPassword]
    );
    res.redirect("/login");
  } catch (error) {
    console.error(error);
    res.send("Error registering user.");
  }
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) return res.send("User not found.");

    const user = users[0];
    const match = await bcrypt.compare(password, user.password);

    if (match) {
      req.session.userId = user.user_id;
      res.redirect("/");
    } else {
      res.send("Incorrect password.");
    }
  } catch (error) {
    console.error(error);
    res.send("Login error.");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// ========== Search Books  ==========

app.get("/search-books", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);

  try {
    const response = await axios.get(
      "https://www.googleapis.com/books/v1/volumes",
      {
        params: {
          q: `intitle:${query}`, // optional: helps prioritize title matches
          maxResults: 20,        // increased to improve chances of relevant results
        },
      }
    );

    const lowerQuery = query.trim().toLowerCase();

    const books = (response.data.items || [])
      .filter((item) => {
        const title = item.volumeInfo.title || "";
        return title.toLowerCase().startsWith(lowerQuery);
      })
      .slice(0, 5) // limit to 5 results *after* filtering
      .map((item) => ({
        id: item.id,
        title: item.volumeInfo.title,
        authors: (item.volumeInfo.authors || []).join(", "),
      }));

    res.json(books);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});


// ========== Show Book Detail Page ==========

app.get("/book/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const response = await axios.get(
      `https://www.googleapis.com/books/v1/volumes/${id}`
    );
    const book = response.data.volumeInfo;

    const bookDetails = {
      id,
      title: book.title,
      authors: (book.authors || []).join(", "),
      description: book.description || "No description available.",
      thumbnail: book.imageLinks?.thumbnail || "",
    };

    res.render("book", { book: bookDetails });
  } catch (err) {
    console.error(err);
    res.send("Book not found.");
  }
});

// ========== Submit Note and Rating ==========

app.post("/submit-review", async (req, res) => {
  const { bookId, title, authors, thumbnail, note, rating } = req.body;
  const userId = req.session.userId;

  if (!userId) return res.redirect("/login");

  try {
    console.log("Submitting review for:", {
      bookId,
      title,
      authors,
      thumbnail,
      note,
      rating,
    });

    // Insert book only if it doesn't exist
    const [existing] = await db.query("SELECT * FROM books WHERE book_id = ?", [
      bookId,
    ]);
    if (existing.length === 0) {
      await db.query(
        "INSERT INTO books (book_id, title, author, thumbnail) VALUES (?, ?, ?, ?)",
        [bookId, title, authors, thumbnail]
      );
    }

    // Insert note
    await db.query(
      "INSERT INTO notes (user_id, book_id, content, created_at) VALUES (?, ?, ?, NOW())",
      [userId, bookId, note]
    );

    // Insert or update rating
    await db.query(
      `INSERT INTO ratings (user_id, book_id, rating)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
      [userId, bookId, rating]
    );

    res.redirect("/dashboard");
  } catch (err) {
    console.error("❌ Review submission error:", err);
    res.send("Error submitting review.");
  }
});

// ========== Dashboard ==========

app.get("/dashboard", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");

  try {
    const [userRows] = await db.query(
      "SELECT username, email FROM users WHERE user_id = ?",
      [req.session.userId]
    );
    const user = userRows[0];

    const [reviews] = await db.query(
      `SELECT b.title, b.author, b.thumbnail, n.content AS note, r.rating
       FROM books b
       JOIN notes n ON b.book_id = n.book_id
       LEFT JOIN ratings r ON b.book_id = r.book_id AND r.user_id = n.user_id
       WHERE n.user_id = ?`,
      [req.session.userId]
    );

    res.render("dashboard", { user, books: reviews });
  } catch (err) {
    console.error(err);
    res.send("Error loading dashboard.");
  }
});

// ========== Edit Book Review Page ==========
app.get("/editbook", async (req, res) => {
  const { title } = req.query;
  const userId = req.session.userId;

  try {
    const [bookRows] = await db.query(
      `SELECT b.book_id, b.title, b.author, b.thumbnail, n.content AS note, r.rating
       FROM books b
       JOIN notes n ON b.book_id = n.book_id
       LEFT JOIN ratings r ON b.book_id = r.book_id AND r.user_id = n.user_id
       WHERE b.title = ? AND n.user_id = ?`,
      [title, userId]
    );

    if (bookRows.length === 0) return res.send("Review not found.");

    res.render("edit", { book: bookRows[0] });
  } catch (err) {
    console.error(err);
    res.send("Error loading edit page.");
  }
});

app.post("/editbook", async (req, res) => {
  const { bookId, note, rating } = req.body;
  const userId = req.session.userId;

  try {
    await db.query(
      `UPDATE notes SET content = ? WHERE book_id = ? AND user_id = ?`,
      [note, bookId, userId]
    );

    await db.query(
      `INSERT INTO ratings (user_id, book_id, rating)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
      [userId, bookId, rating]
    );

    res.redirect("/dashboard");
  } catch (err) {
    console.error("Edit error:", err);
    res.send("Error editing review.");
  }
});

app.post("/delete-review", async (req, res) => {
  const { title } = req.body;
  const userId = req.session.userId;

  if (!userId) return res.redirect("/login");

  console.log("Title received for deletion:", title);  

  try {
    const [bookRows] = await db.query(
      "SELECT book_id FROM books WHERE title = ?",
      [title]
    );

    console.log("Book rows from database:", bookRows);  

    if (bookRows.length === 0) return res.send("Book not found.");

    const bookId = bookRows[0].book_id;

    // Delete note
    await db.query("DELETE FROM notes WHERE book_id = ? AND user_id = ?", [
      bookId,
      userId,
    ]);

    // Delete rating
    await db.query("DELETE FROM ratings WHERE book_id = ? AND user_id = ?", [
      bookId,
      userId,
    ]);

    res.redirect("/dashboard");
  } catch (err) {
    console.error("Delete error:", err);
    res.send("Error deleting review.");
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
