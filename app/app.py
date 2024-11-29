from flask import Flask

app = Flask(__name__)

@app.route("/")
def hello_world():
    print("Hello, World!")
    return "Hello, World!"

@app.route("/health")
def health():
    return "OK"

@app.route("/test")
def TestRoute():
    return "Tested"

@app.route("/test-again")
def TestRoute2():
    return "Tested 2"

if __name__ == "__main__":
    hello_world()
    app.run(host="0.0.0.0", port=8080)
