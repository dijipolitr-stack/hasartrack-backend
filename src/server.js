const app  = require('./app');
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🛡️  HasarTrack API — port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});
