from fastapi import FastAPI

app = FastAPI()

@app.get("/")
async def hello_world():
    return {"message": "Hello, World!"}

@app.get("/health")
async def health():
    return {"status": "OK"}

@app.get("/test")
async def test_route():
    return {"message": "Tested"}

@app.get("/test-again")
async def test_route_2():
    return {"message": "Tested 2"}

@app.get("/extra-test")
async def extra_test():
    return {"message": "Extra Test"}

@app.get("/extra-test2")
async def extra_test_2():
    return {"message": "Extra Test 2"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8030)