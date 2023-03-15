module.exports = {
    apps : [
      {
        name: "calendar",
        script: "index.js",
        env: {
            NODE_ENV: "production",
        },
        log_date_format: "YYYY-MM-DD HH:mm"
      },
    ],
};