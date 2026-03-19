from flask import Flask,render_template,request

app = Flask(__name__)

@app.route("/",methods=["GET",'POST'])
def index():
    return(render_template("index.html"))

@app.route("/main",methods=["GET",'POST'])
def main():
    return(render_template("main.html"))

@app.route("/transfermoney",methods=["GET",'POST'])
def transfermoney():
    return(render_template("transfermoney.html"))

if __name__ == "__main__":
    app.run(debug=True)